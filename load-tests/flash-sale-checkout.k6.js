/**
 * k6 Flash-Sale Concurrency Test (10 Simultaneous Buyers vs. Last 1 Item in Stock)
 *
 * Proves end-to-end under real HTTP + API Gateway + Order Service (Outbox) + RabbitMQ +
 * Catalog Service (PostgreSQL Serializable + Optimistic Locking CAS) + Payment Service:
 *   1. Exactly 1 buyer wins (`PAID`), 9 buyers are rejected (`400`) or Saga-compensated (`CANCELLED`).
 *   2. Final product stock is strictly `0` (never negative / zero overselling).
 *   3. Server-side authoritative pricing ignores tampered client cart prices (`$0.01` -> `$499.99`).
 *
 * Usage:
 *   docker run --rm --network host -i grafana/k6 run - < load-tests/flash-sale-checkout.k6.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost';
const BUYER_COUNT = 10;
const AUTHORITATIVE_PRICE = 499.99;

const ordersPaid = new Counter('flash_sale_orders_paid');
const ordersRejectedOrCancelled = new Counter(
  'flash_sale_orders_rejected_or_cancelled',
);
const ordersPrecheckRejected = new Counter('flash_sale_precheck_rejected');
const ordersSagaCancelled = new Counter('flash_sale_saga_cancelled');
const checkoutDuration = new Trend('flash_sale_checkout_duration', true);
const sagaSettleDuration = new Trend('flash_sale_saga_settle_duration', true);

export const options = {
  scenarios: {
    flash_sale_rush: {
      executor: 'per-vu-iterations',
      vus: BUYER_COUNT,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    flash_sale_orders_paid: ['count==1'],
    flash_sale_orders_rejected_or_cancelled: ['count==9'],
    checks: ['rate==1.0'],
  },
};

export function setup() {
  const ts = Date.now();

  // 1. Login as seeded ADMIN
  const adminLoginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({
      email: __ENV.ADMIN_EMAIL || 'admin@shop.local',
      password: __ENV.ADMIN_PASSWORD || 'AdminPass123!',
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (adminLoginRes.status !== 201 && adminLoginRes.status !== 200) {
    throw new Error(
      `Admin login failed (${adminLoginRes.status}): ${adminLoginRes.body}`,
    );
  }
  const adminToken = adminLoginRes.json('accessToken');

  // 2. Pick an existing category
  const catRes = http.get(`${BASE_URL}/api/catalog/categories`);
  const categories = catRes.json();
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error('No catalog categories available for flash-sale test');
  }
  const categoryId = categories[0].id;

  // 3. Create a limited-edition product with stock = 1
  const createProdRes = http.post(
    `${BASE_URL}/api/catalog/products`,
    JSON.stringify({
      title: `k6 Flash-Sale Limited GPU #${ts}`,
      description: 'Concurrency stress test item with strictly 1 unit in stock',
      price: AUTHORITATIVE_PRICE,
      stock: 1,
      categoryId,
      isActive: true,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    },
  );
  if (createProdRes.status !== 201) {
    throw new Error(
      `Failed to create flash-sale product (${createProdRes.status}): ${createProdRes.body}`,
    );
  }
  const product = createProdRes.json();

  // 4. Register 10 distinct buyers and populate each buyer's Redis cart with the last item
  const buyers = [];
  for (let i = 0; i < BUYER_COUNT; i++) {
    const email = `k6-flash-${ts}-${i}@shop.local`;
    const regRes = http.post(
      `${BASE_URL}/api/auth/register`,
      JSON.stringify({
        email,
        password: 'FlashSalePass123!',
        role: 'ADMIN', // Attempt privilege escalation — must be ignored and downgraded to CUSTOMER
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (regRes.status !== 201) {
      throw new Error(
        `Failed to register buyer #${i} (${regRes.status}): ${regRes.body}`,
      );
    }
    const authData = regRes.json();
    if (authData.user.role !== 'CUSTOMER') {
      throw new Error(
        `SECURITY FAILURE: buyer #${i} registered with role=${authData.user.role}`,
      );
    }

    // Buyer #0 intentionally sends a tampered $0.01 unitPrice to verify server-side price quoting
    const submittedPrice = i === 0 ? 0.01 : AUTHORITATIVE_PRICE;
    const cartRes = http.post(
      `${BASE_URL}/api/cart/items`,
      JSON.stringify({
        productId: product.id,
        productTitle: product.title,
        unitPrice: submittedPrice,
        quantity: 1,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authData.accessToken}`,
        },
      },
    );
    if (cartRes.status !== 201 && cartRes.status !== 200) {
      throw new Error(
        `Failed to add cart item for buyer #${i} (${cartRes.status}): ${cartRes.body}`,
      );
    }

    buyers.push({
      index: i,
      email,
      userId: authData.user.id,
      accessToken: authData.accessToken,
      idempotencyKey: `k6-flash-${ts}-buyer-${i}`,
    });
  }

  return {
    adminToken,
    product,
    buyers,
  };
}

export default function (data) {
  const buyer = data.buyers[__VU - 1];
  const startedAt = Date.now();

  const checkoutRes = http.post(
    `${BASE_URL}/api/orders/checkout`,
    JSON.stringify({}),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyer.accessToken}`,
        'X-Idempotency-Key': buyer.idempotencyKey,
      },
    },
  );

  checkoutDuration.add(checkoutRes.timings.duration);

  // Fast-path rejection when pre-check already sees stock === 0
  if (checkoutRes.status === 400) {
    ordersPrecheckRejected.add(1);
    ordersRejectedOrCancelled.add(1);
    check(checkoutRes, {
      'fast-rejected out of stock (400)': (r) => r.status === 400,
    });
    return;
  }

  check(checkoutRes, {
    'checkout accepted into Saga (201)': (r) => r.status === 201,
  });

  const createdOrder = checkoutRes.json();
  check(createdOrder, {
    'authoritative server price enforced ($499.99)': (o) =>
      o && Number(o.totalAmount) === AUTHORITATIVE_PRICE,
  });

  // Poll order status until Saga reaches terminal state (PAID, CANCELLED, or FAILED)
  let finalStatus = createdOrder.status;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (finalStatus !== 'PENDING') break;
    sleep(0.2);
    const pollRes = http.get(`${BASE_URL}/api/orders/${createdOrder.id}`, {
      headers: {
        Authorization: `Bearer ${buyer.accessToken}`,
      },
    });
    if (pollRes.status === 200) {
      finalStatus = pollRes.json('status');
    }
  }

  sagaSettleDuration.add(Date.now() - startedAt);

  check(finalStatus, {
    'order reached terminal Saga state': (s) =>
      s === 'PAID' || s === 'CANCELLED' || s === 'FAILED',
  });

  if (finalStatus === 'PAID') {
    ordersPaid.add(1);
  } else {
    ordersSagaCancelled.add(1);
    ordersRejectedOrCancelled.add(1);
  }
}

export function teardown(data) {
  // Verify final stock in catalog_db is strictly 0 (never negative)
  // Small pause to ensure cache invalidation after reservation has settled
  sleep(0.5);
  const prodRes = http.get(
    `${BASE_URL}/api/catalog/products/${data.product.id}`,
  );
  const prod = prodRes.json();
  const stockOk = check(prod, {
    'final product stock is strictly 0 (zero overselling)': (p) =>
      p && Number(p.stock) === 0,
  });

  console.log(
    `[Flash-Sale Summary] Product="${data.product.title}" | initialStock=1 | finalStock=${prod ? prod.stock : 'unknown'} | verified=${stockOk}`,
  );

  // Clean up temporary flash-sale test product
  http.del(`${BASE_URL}/api/catalog/products/${data.product.id}`, null, {
    headers: {
      Authorization: `Bearer ${data.adminToken}`,
    },
  });
}
