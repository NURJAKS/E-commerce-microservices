import { ConflictException, ForbiddenException } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import { ROUTING_KEYS } from '@shop/rmq';
import { CatalogService } from './catalog.service';
import { PrismaService } from './prisma.service';

describe('CatalogService Real PostgreSQL Integration — Optimistic Locking Concurrency & Inbox Pattern', () => {
  let prisma: PrismaService;
  let catalogService: CatalogService;
  let mockRmqService: { publish: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };

  const createdCategoryIds: string[] = [];
  const createdProductIds: string[] = [];
  const createdEventIds: string[] = [];

  beforeAll(async () => {
    process.env.CATALOG_DATABASE_URL =
      process.env.CATALOG_DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/catalog_db?schema=public';

    prisma = new PrismaService();
    await prisma.$connect();

    mockRmqService = {
      publish: vi.fn().mockResolvedValue(true),
      subscribe: vi.fn().mockResolvedValue(undefined),
    };

    catalogService = new CatalogService(prisma, mockRmqService as any);
  });

  afterEach(async () => {
    mockRmqService.publish.mockClear();

    if (createdEventIds.length > 0) {
      await prisma.processedEvent.deleteMany({
        where: { eventId: { in: createdEventIds } },
      });
      createdEventIds.length = 0;
    }

    if (createdProductIds.length > 0) {
      await prisma.product.deleteMany({
        where: { id: { in: createdProductIds } },
      });
      createdProductIds.length = 0;
    }

    if (createdCategoryIds.length > 0) {
      await prisma.category.deleteMany({
        where: { id: { in: createdCategoryIds } },
      });
      createdCategoryIds.length = 0;
    }
  });

  afterAll(async () => {
    await catalogService.onModuleDestroy();
    await prisma.$disconnect();
  });

  it('allows exactly 1 of 10 parallel checkouts for the last item in stock (stock stays 0, never negative)', async () => {
    const suffix = crypto.randomBytes(4).toString('hex');
    const category = await prisma.category.create({
      data: {
        name: `Concurrency Test Category ${suffix}`,
        slug: `concurrency-cat-${suffix}`,
      },
    });
    createdCategoryIds.push(category.id);

    const product = await prisma.product.create({
      data: {
        title: `Limited Edition GPU ${suffix}`,
        description: 'Only 1 unit in stock for concurrency test',
        price: 999.99,
        stock: 1,
        images: [],
        categoryId: category.id,
        isActive: true,
      },
    });
    createdProductIds.push(product.id);

    const parallelAttempts = 10;
    const requests = Array.from({ length: parallelAttempts }, (_, idx) => {
      const orderId = crypto.randomUUID();
      const eventId = `test-concurrency-${suffix}-${idx}`;
      createdEventIds.push(eventId);

      return catalogService.handleOrderCreated(
        {
          orderId,
          userId: crypto.randomUUID(),
          items: [
            {
              productId: product.id,
              productTitle: product.title,
              quantity: 1,
              unitPrice: 999.99,
            },
          ],
          totalAmount: 999.99,
          createdAt: new Date().toISOString(),
        },
        `trace-concurrency-${idx}`,
        eventId,
      );
    });

    await Promise.all(requests);

    const reservedCalls = mockRmqService.publish.mock.calls.filter(
      ([routingKey]) => routingKey === ROUTING_KEYS.STOCK_RESERVED,
    );
    const failedCalls = mockRmqService.publish.mock.calls.filter(
      ([routingKey]) => routingKey === ROUTING_KEYS.STOCK_FAILED,
    );

    expect(reservedCalls).toHaveLength(1);
    expect(failedCalls).toHaveLength(parallelAttempts - 1);

    // Verify real PostgreSQL state: stock is strictly 0 (never negative) and version incremented exactly once
    const finalProduct = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(finalProduct.stock).toBe(0);
    expect(finalProduct.version).toBe(2);

    // Exactly 1 ProcessedEvent row persisted for the winning transaction
    const processedRows = await prisma.processedEvent.findMany({
      where: { eventId: { in: createdEventIds } },
    });
    expect(processedRows).toHaveLength(1);
  });

  it('enforces Inbox Pattern on real PostgreSQL so redelivered order.created and payment.failed events execute Exactly-Once', async () => {
    const suffix = crypto.randomBytes(4).toString('hex');
    const category = await prisma.category.create({
      data: {
        name: `Inbox Test Category ${suffix}`,
        slug: `inbox-cat-${suffix}`,
      },
    });
    createdCategoryIds.push(category.id);

    const product = await prisma.product.create({
      data: {
        title: `Inbox Test Keyboard ${suffix}`,
        description: 'Verifies ProcessedEvent PK deduplication',
        price: 150.0,
        stock: 5,
        images: [],
        categoryId: category.id,
        isActive: true,
      },
    });
    createdProductIds.push(product.id);

    const orderId = crypto.randomUUID();
    const orderEventId = `test-inbox-order-${suffix}`;
    createdEventIds.push(orderEventId);

    const orderEvent = {
      orderId,
      userId: crypto.randomUUID(),
      items: [
        {
          productId: product.id,
          productTitle: product.title,
          quantity: 2,
          unitPrice: 150.0,
        },
      ],
      totalAmount: 300.0,
      createdAt: new Date().toISOString(),
    };

    // Deliver the exact same order.created event TWICE
    await catalogService.handleOrderCreated(orderEvent, 'trace-1', orderEventId);
    await catalogService.handleOrderCreated(orderEvent, 'trace-1', orderEventId);

    const afterDeduction = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    // Stock must be deducted ONCE (5 -> 3, NOT 5 -> 1)
    expect(afterDeduction.stock).toBe(3);
    expect(mockRmqService.publish).toHaveBeenCalledTimes(1);
    expect(mockRmqService.publish).toHaveBeenCalledWith(
      ROUTING_KEYS.STOCK_RESERVED,
      expect.objectContaining({ orderId }),
      'trace-1',
    );

    // Deliver the exact same payment.failed compensation event TWICE
    const compEventId = `test-inbox-comp-${suffix}`;
    createdEventIds.push(compEventId);

    const paymentFailedEvent = {
      paymentId: crypto.randomUUID(),
      orderId,
      userId: orderEvent.userId,
      items: orderEvent.items,
      amount: 300.0,
      reason: 'Card declined',
      failedAt: new Date().toISOString(),
    };

    await catalogService.handlePaymentFailed(
      paymentFailedEvent,
      'trace-1',
      compEventId,
    );
    await catalogService.handlePaymentFailed(
      paymentFailedEvent,
      'trace-1',
      compEventId,
    );

    const afterCompensation = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    // Stock must be restored ONCE (3 -> 5, NOT 3 -> 7)
    expect(afterCompensation.stock).toBe(5);

    // Deliver a payment.refunded event TWICE and verify StockMovement(REFUND_RESTORE) is recorded ONCE
    const refundEventId = `test-inbox-refund-${suffix}`;
    createdEventIds.push(refundEventId);

    const paymentRefundedEvent = {
      paymentId: crypto.randomUUID(),
      orderId,
      userId: orderEvent.userId,
      items: orderEvent.items,
      amount: 300.0,
      refundTransactionId: `ref_${suffix}`,
      reason: 'Customer requested refund',
      refundedAt: new Date().toISOString(),
    };

    await catalogService.handlePaymentRefunded(
      paymentRefundedEvent,
      'trace-refund',
      refundEventId,
    );
    await catalogService.handlePaymentRefunded(
      paymentRefundedEvent,
      'trace-refund',
      refundEventId,
    );

    const afterRefund = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(afterRefund.stock).toBe(7);

    const movements = await prisma.stockMovement.findMany({
      where: { productId: product.id, orderId },
      orderBy: { createdAt: 'asc' },
    });
    expect(movements.map((m) => [m.type, m.delta])).toEqual([
      ['ORDER_RESERVED', -2],
      ['PAYMENT_FAILED_RESTORE', 2],
      ['REFUND_RESTORE', 2],
    ]);
  });

  it('supports typo-tolerant PostgreSQL FTS + pg_trgm search, autocomplete, and price/stock filters', async () => {
    await catalogService.ensureSearchIndexes();

    const suffix = crypto.randomBytes(4).toString('hex');
    const category = await prisma.category.create({
      data: {
        name: `Search Test Cat ${suffix}`,
        slug: `search-cat-${suffix}`,
      },
    });
    createdCategoryIds.push(category.id);

    const kb = await prisma.product.create({
      data: {
        title: `Tactile Mechanical Keyboard ${suffix}`,
        description: 'Hot-swappable wireless ergonomic keyboard',
        price: 185,
        stock: 5,
        images: [],
        categoryId: category.id,
        isActive: true,
      },
    });
    const hp = await prisma.product.create({
      data: {
        title: `Studio Noise Cancelling Headphones ${suffix}`,
        description: 'Over-ear acoustic wireless audio headset',
        price: 320,
        stock: 0,
        images: [],
        categoryId: category.id,
        isActive: true,
      },
    });
    createdProductIds.push(kb.id, hp.id);

    // Typo-tolerant search ("keybord" matches "Keyboard" via pg_trgm)
    const fuzzyResult = await catalogService.getProducts({
      search: 'keybord',
      categoryId: category.id,
      minPrice: 100,
      maxPrice: 250,
      inStockOnly: true,
    });
    expect(fuzzyResult.items.map((p) => p.id)).toContain(kb.id);
    expect(fuzzyResult.items.map((p) => p.id)).not.toContain(hp.id);

    // Typo-tolerant autocomplete ("headfones" matches "Headphones")
    const suggestions = await catalogService.autocompleteProducts('headfones', 6);
    expect(suggestions.map((s) => s.id)).toContain(hp.id);
  });

  it('enforces Verified Purchase reviews via local payment.succeeded projection and updates denormalized avgRating & reviewsCount', async () => {
    const suffix = crypto.randomBytes(4).toString('hex');
    const category = await prisma.category.create({
      data: {
        name: `Review Cat ${suffix}`,
        slug: `review-cat-${suffix}`,
      },
    });
    createdCategoryIds.push(category.id);

    const product = await prisma.product.create({
      data: {
        title: `Verified Review Product ${suffix}`,
        description: 'Tests local VerifiedPurchase projection',
        price: 120,
        stock: 10,
        images: [],
        categoryId: category.id,
        isActive: true,
      },
    });
    createdProductIds.push(product.id);

    const buyer1 = crypto.randomUUID();
    const buyer2 = crypto.randomUUID();
    const nonBuyer = crypto.randomUUID();

    // Non-buyer cannot review
    await expect(
      catalogService.createProductReview(product.id, nonBuyer, 'nope@shop.local', {
        rating: 1,
        comment: 'Never bought it',
      }),
    ).rejects.toThrow(ForbiddenException);

    // Project payment.succeeded for buyer1 and buyer2
    const evt1 = `test-vp-1-${suffix}`;
    const evt2 = `test-vp-2-${suffix}`;
    createdEventIds.push(evt1, evt2);

    await catalogService.handlePaymentSucceeded(
      {
        paymentId: crypto.randomUUID(),
        orderId: crypto.randomUUID(),
        userId: buyer1,
        userEmail: 'buyer1@shop.local',
        items: [
          {
            productId: product.id,
            productTitle: product.title,
            quantity: 1,
            unitPrice: 120,
          },
        ],
        amount: 120,
        transactionId: `tx_1_${suffix}`,
        paidAt: new Date().toISOString(),
      },
      'trace-vp-1',
      evt1,
    );

    await catalogService.handlePaymentSucceeded(
      {
        paymentId: crypto.randomUUID(),
        orderId: crypto.randomUUID(),
        userId: buyer2,
        userEmail: 'buyer2@shop.local',
        items: [
          {
            productId: product.id,
            productTitle: product.title,
            quantity: 1,
            unitPrice: 120,
          },
        ],
        amount: 120,
        transactionId: `tx_2_${suffix}`,
        paidAt: new Date().toISOString(),
      },
      'trace-vp-2',
      evt2,
    );

    const beforeReviews = await catalogService.getProductReviews(
      product.id,
      buyer1,
    );
    expect(beforeReviews.canReview).toBe(true);

    await catalogService.createProductReview(
      product.id,
      buyer1,
      'buyer1@shop.local',
      { rating: 5, comment: 'Fantastic quality!' },
    );
    await catalogService.createProductReview(
      product.id,
      buyer2,
      'buyer2@shop.local',
      { rating: 4, comment: 'Very solid product.' },
    );

    // Duplicate review by buyer1 rejected
    await expect(
      catalogService.createProductReview(
        product.id,
        buyer1,
        'buyer1@shop.local',
        { rating: 5, comment: 'Trying again' },
      ),
    ).rejects.toThrow(ConflictException);

    // Denormalized avgRating (4.50) and reviewsCount (2) persisted on Product
    const updatedProduct = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(Number(updatedProduct.avgRating)).toBe(4.5);
    expect(updatedProduct.reviewsCount).toBe(2);
  });

  it('emits catalog.product.restocked automatically when FAIL_PAYMENT compensation transitions stock 0 -> >0', async () => {
    const suffix = crypto.randomBytes(4).toString('hex');
    const category = await prisma.category.create({
      data: {
        name: `Restock Cat ${suffix}`,
        slug: `restock-cat-${suffix}`,
      },
    });
    createdCategoryIds.push(category.id);

    const product = await prisma.product.create({
      data: {
        title: `Sold Out Ring ${suffix}`,
        description: 'Starts at stock 0 to test reactive restock alerts',
        price: 329,
        stock: 0,
        images: [],
        categoryId: category.id,
        isActive: true,
      },
    });
    createdProductIds.push(product.id);

    const waiterId = crypto.randomUUID();
    await catalogService.subscribeStockAlert(
      product.id,
      `waiter-${suffix}@shop.local`,
      waiterId,
    );

    const failEventId = `test-restock-fail-${suffix}`;
    createdEventIds.push(failEventId);

    await catalogService.handlePaymentFailed(
      {
        paymentId: crypto.randomUUID(),
        orderId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        items: [
          {
            productId: product.id,
            productTitle: product.title,
            quantity: 1,
            unitPrice: 329,
          },
        ],
        amount: 329,
        reason: 'FAIL_PAYMENT trigger',
        failedAt: new Date().toISOString(),
      },
      'trace-restock',
      failEventId,
    );

    expect(mockRmqService.publish).toHaveBeenCalledWith(
      ROUTING_KEYS.PRODUCT_RESTOCKED,
      expect.objectContaining({
        productId: product.id,
        stock: 1,
        subscribers: [
          { userId: waiterId, email: `waiter-${suffix}@shop.local` },
        ],
      }),
      'trace-restock',
    );

    // Subscription should now be marked notified so it won't fire twice
    const checkAfter = await catalogService.isSubscribedToStockAlert(
      product.id,
      `waiter-${suffix}@shop.local`,
      waiterId,
    );
    expect(checkAfter.subscribed).toBe(false);
  });
});
