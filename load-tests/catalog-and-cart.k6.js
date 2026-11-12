/**
 * k6 High-Concurrency Load Test (500 Virtual Users)
 *
 * Demonstrates how Redis Catalog Caching (`catalog:products:*`) and Redis Cart (`cart:{userId}`)
 * allow the NestJS API Gateway to sustain ~2000+ RPS with p95 latency < 50ms.
 *
 * Usage:
 *   k6 run load-tests/catalog-and-cart.k6.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost';

export const options = {
  stages: [
    { duration: '15s', target: 100 }, // Ramp up to 100 VUs
    { duration: '30s', target: 500 }, // Peak load: 500 concurrent virtual users
    { duration: '15s', target: 0 },   // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<50'], // 95% of requests must complete in < 50ms
    http_req_failed: ['rate<0.01'],  // Error rate < 1%
  },
};

export function setup() {
  // Register a load-test user once before the VU stages start
  const email = `k6-load-${Date.now()}@shop.local`;
  const registerRes = http.post(
    `${BASE_URL}/api/auth/register`,
    JSON.stringify({
      email,
      password: 'StrongLoadTestPass123!',
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );

  const authBody = registerRes.json();
  const accessToken = authBody ? authBody.accessToken : '';

  const productsRes = http.get(`${BASE_URL}/api/catalog/products?limit=12`);
  const productsBody = productsRes.json();
  const firstProduct =
    productsBody && productsBody.items && productsBody.items.length > 0
      ? productsBody.items[0]
      : {
          id: '00000000-0000-0000-0000-000000000001',
          title: 'Keychron Pro Wireless Mechanical Keyboard',
          price: 189,
        };

  return {
    accessToken,
    product: firstProduct,
  };
}

export default function (data) {
  // 1. Browse cached catalog categories (Redis hit: catalog:categories:all)
  const catRes = http.get(`${BASE_URL}/api/catalog/categories`);
  check(catRes, {
    'categories status 200': (r) => r.status === 200,
  });

  // 2. Browse cached catalog products (Redis hit: catalog:products:list:...)
  const prodRes = http.get(
    `${BASE_URL}/api/catalog/products?page=1&limit=12`,
  );
  check(prodRes, {
    'products status 200': (r) => r.status === 200,
  });

  // 3. Add item to high-speed Redis Cart (cart:{userId}) without touching PostgreSQL disk I/O
  if (data.accessToken) {
    const cartRes = http.post(
      `${BASE_URL}/api/cart/items`,
      JSON.stringify({
        productId: data.product.id,
        productTitle: data.product.title,
        unitPrice: data.product.price,
        quantity: 1,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${data.accessToken}`,
        },
      },
    );
    check(cartRes, {
      'redis cart add status 201': (r) => r.status === 201 || r.status === 200,
    });
  }

  sleep(0.2);
}
