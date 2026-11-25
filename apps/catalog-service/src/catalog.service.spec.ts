import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CACHE_TTL_BASE_SECONDS,
  CACHE_TTL_JITTER_SECONDS,
  CatalogService,
} from './catalog.service';
import { ROUTING_KEYS } from '@shop/rmq';

describe('CatalogService — Inbox Pattern, Cache Invalidation & TTL Jitter', () => {
  let catalogService: CatalogService;
  let mockPrisma: any;
  let mockRmqService: any;
  let mockRedis: any;

  beforeEach(() => {
    mockPrisma = {
      $transaction: vi.fn(async (cb: any) => cb(mockPrisma)),
      $executeRaw: vi.fn().mockResolvedValue(1),
      processedEvent: {
        create: vi.fn().mockResolvedValue({}),
      },
      stockMovement: {
        create: vi.fn().mockResolvedValue({}),
      },
      discount: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      discountRedemption: {
        count: vi.fn().mockResolvedValue(0),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      verifiedPurchase: {
        upsert: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn(),
      },
      review: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        aggregate: vi.fn(),
      },
      stockAlertSubscription: {
        upsert: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      product: {
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
    };

    mockRmqService = {
      publish: vi.fn().mockResolvedValue(true),
      subscribe: vi.fn().mockResolvedValue(undefined),
    };

    catalogService = new CatalogService(mockPrisma, mockRmqService);

    mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      scan: vi.fn().mockResolvedValue(['0', ['catalog:products:list:p=1']]),
      zincrby: vi.fn().mockResolvedValue('1'),
      zrevrange: vi.fn().mockResolvedValue([]),
      zadd: vi.fn().mockResolvedValue(1),
      zremrangebyrank: vi.fn().mockResolvedValue(0),
      expire: vi.fn().mockResolvedValue(1),
      ping: vi.fn().mockResolvedValue('PONG'),
      quit: vi.fn().mockResolvedValue('OK'),
    };
    (catalogService as any).redis = mockRedis;
  });

  it('generates cache TTL with random jitter within [540, 660] seconds to prevent Cache Stampede', () => {
    const samples = Array.from({ length: 100 }, () =>
      catalogService.getCacheTtlWithJitter(),
    );

    const minAllowed = CACHE_TTL_BASE_SECONDS - CACHE_TTL_JITTER_SECONDS;
    const maxAllowed = CACHE_TTL_BASE_SECONDS + CACHE_TTL_JITTER_SECONDS;

    for (const ttl of samples) {
      expect(ttl).toBeGreaterThanOrEqual(minAllowed);
      expect(ttl).toBeLessThanOrEqual(maxAllowed);
    }

    // Across 100 samples, jitter should produce more than 1 distinct TTL value
    expect(new Set(samples).size).toBeGreaterThan(1);
  });

  it('explicitly deletes the updated product Redis key and invalidates product list cache on updateProduct', async () => {
    const product = {
      id: 'prod-123',
      title: 'Updated Keyboard',
      description: 'Desc',
      price: 199,
      stock: 10,
      images: [],
      categoryId: 'cat-1',
      isActive: true,
      version: 2,
    };
    mockPrisma.product.findUnique.mockResolvedValue(product);
    mockPrisma.product.update.mockResolvedValue(product);

    await catalogService.updateProduct('prod-123', { price: 199 });

    expect(mockRedis.del).toHaveBeenCalledWith('catalog:products:item:prod-123');
    expect(mockRedis.scan).toHaveBeenCalledWith(
      '0',
      'MATCH',
      'catalog:products:list:*',
      'COUNT',
      100,
    );
    expect(mockRedis.del).toHaveBeenCalledWith('catalog:products:list:p=1');
  });

  it('skips duplicate order.created redelivery via Inbox Pattern (P2002) without deducting stock or emitting STOCK_FAILED', async () => {
    const p2002 = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    mockPrisma.processedEvent.create.mockRejectedValue(p2002);

    await catalogService.handleOrderCreated(
      {
        orderId: 'ord-1',
        userId: 'user-1',
        items: [
          {
            productId: 'prod-1',
            productTitle: 'Keyboard',
            quantity: 1,
            unitPrice: 100,
          },
        ],
        totalAmount: 100,
        createdAt: new Date().toISOString(),
      },
      'trace-1',
      'evt-order-1',
    );

    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    expect(mockRmqService.publish).not.toHaveBeenCalled();
  });

  it('publishes STOCK_FAILED when Optimistic Locking CAS returns 0 updated rows', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({
      id: 'prod-1',
      stock: 1,
      version: 1,
      isActive: true,
    });
    mockPrisma.$executeRaw.mockResolvedValue(0);

    await catalogService.handleOrderCreated(
      {
        orderId: 'ord-race',
        userId: 'user-1',
        items: [
          {
            productId: 'prod-1',
            productTitle: 'Keyboard',
            quantity: 1,
            unitPrice: 100,
          },
        ],
        totalAmount: 100,
        createdAt: new Date().toISOString(),
      },
      'trace-race',
      'evt-race-1',
    );

    expect(mockRmqService.publish).toHaveBeenCalledWith(
      ROUTING_KEYS.STOCK_FAILED,
      expect.objectContaining({
        orderId: 'ord-race',
      }),
      'trace-race',
    );
  });

  it('skips duplicate payment.failed compensation via Inbox Pattern (P2002) to prevent stock inflation', async () => {
    const p2002 = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    mockPrisma.processedEvent.create.mockRejectedValue(p2002);

    await catalogService.handlePaymentFailed(
      {
        paymentId: 'pay-1',
        orderId: 'ord-1',
        userId: 'user-1',
        items: [
          {
            productId: 'prod-1',
            productTitle: 'Keyboard',
            quantity: 1,
            unitPrice: 100,
          },
        ],
        amount: 100,
        reason: 'Declined',
        failedAt: new Date().toISOString(),
      },
      'trace-comp',
      'evt-pay-fail-1',
    );

    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('restores stock, writes StockMovement(REFUND_RESTORE), invalidates cache, and deduplicates payment.refunded', async () => {
    const refundEvent = {
      paymentId: 'pay-1',
      orderId: 'ord-refund-1',
      userId: 'user-1',
      items: [
        {
          productId: 'prod-1',
          productTitle: 'Keyboard',
          quantity: 2,
          unitPrice: 100,
        },
      ],
      amount: 200,
      refundTransactionId: 'ref_12345',
      reason: 'Customer return',
      refundedAt: new Date().toISOString(),
    };

    await catalogService.handlePaymentRefunded(
      refundEvent,
      'trace-ref',
      'evt-ref-1',
    );

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          productId: 'prod-1',
          orderId: 'ord-refund-1',
          delta: 2,
          type: 'REFUND_RESTORE',
        }),
      }),
    );
    expect(mockRedis.del).toHaveBeenCalledWith('catalog:products:item:prod-1');

    // Duplicate delivery is ignored via Inbox P2002
    mockPrisma.$executeRaw.mockClear();
    mockPrisma.stockMovement.create.mockClear();
    mockPrisma.processedEvent.create.mockRejectedValueOnce(
      Object.assign(new Error('Duplicate'), { code: 'P2002' }),
    );
    await catalogService.handlePaymentRefunded(
      refundEvent,
      'trace-ref',
      'evt-ref-1',
    );
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('resolves MinIO object keys to public URLs and records ADMIN_ADJUSTMENT StockMovement on stock edit', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({
      id: 'prod-key-1',
      title: 'Mouse',
      description: 'Desc',
      price: 50,
      stock: 10,
      images: ['products/product-123.webp'],
      categoryId: 'cat-1',
      isActive: true,
      version: 1,
    });
    mockPrisma.product.update.mockResolvedValue({
      id: 'prod-key-1',
      title: 'Mouse',
      description: 'Desc',
      price: 50,
      stock: 25,
      images: ['products/product-123.webp'],
      categoryId: 'cat-1',
      isActive: true,
      version: 2,
    });

    const updated = await catalogService.updateProduct('prod-key-1', {
      stock: 25,
      images: ['products/product-123.webp'],
    });

    expect(updated.images[0]).toBe(
      'http://localhost:9000/products-media/products/product-123.webp',
    );
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          productId: 'prod-key-1',
          delta: 15,
          type: 'ADMIN_ADJUSTMENT',
        }),
      }),
    );
  });

  it('enforces global maxUses and per-user maxUsesPerUser limits during promo validation', async () => {
    const now = Date.now();
    mockPrisma.discount.findUnique.mockResolvedValue({
      id: 'disc-1',
      code: 'LIMITED1',
      percentage: 15,
      fixedAmount: 0,
      validFrom: new Date(now - 60_000),
      validUntil: new Date(now + 60_000),
      maxUses: 10,
      maxUsesPerUser: 1,
      usedCount: 2,
      isActive: true,
    });
    mockPrisma.discountRedemption.count.mockResolvedValueOnce(1);

    const perUserBlocked = await catalogService.validateDiscount(
      'LIMITED1',
      'user-1',
    );
    expect(perUserBlocked.valid).toBe(false);
    expect(perUserBlocked.reason).toContain('per-user usage limit');

    mockPrisma.discount.findUnique.mockResolvedValueOnce({
      id: 'disc-2',
      code: 'SOLDOUT',
      percentage: 10,
      fixedAmount: 0,
      validFrom: new Date(now - 60_000),
      validUntil: new Date(now + 60_000),
      maxUses: 5,
      maxUsesPerUser: null,
      usedCount: 5,
      isActive: true,
    });

    const globalBlocked = await catalogService.validateDiscount(
      'SOLDOUT',
      'user-2',
    );
    expect(globalBlocked.valid).toBe(false);
    expect(globalBlocked.reason).toContain('maximum total usage limit');
  });

  it('tracks Popular Searches and Recently Viewed products using Redis Sorted Sets (ZINCRBY / ZADD / ZREVRANGE)', async () => {
    await catalogService.recordSearchQuery('  Mechanical Keyboard  ');
    expect(mockRedis.zincrby).toHaveBeenCalledWith(
      'catalog:search:popular',
      1,
      'mechanical keyboard',
    );

    mockRedis.zrevrange.mockResolvedValueOnce([
      'keyboard',
      '12',
      'headphones',
      '7',
    ]);
    const popular = await catalogService.getPopularSearches(5);
    expect(popular).toEqual([
      { term: 'keyboard', count: 12 },
      { term: 'headphones', count: 7 },
    ]);

    const recorded = await catalogService.recordProductView('viewer-1', 'p-2');
    expect(recorded).toEqual({ recorded: true });
    expect(mockRedis.zadd).toHaveBeenCalledWith(
      'catalog:recent:viewer-1',
      expect.any(Number),
      'p-2',
    );
    expect(mockRedis.zremrangebyrank).toHaveBeenCalledWith(
      'catalog:recent:viewer-1',
      0,
      -13,
    );

    mockRedis.zrevrange.mockResolvedValueOnce(['p-2', 'p-1']);
    mockPrisma.product.findMany.mockResolvedValueOnce([
      {
        id: 'p-1',
        title: 'First',
        description: 'D1',
        price: 10,
        stock: 5,
        images: [],
        categoryId: 'c1',
        isActive: true,
      },
      {
        id: 'p-2',
        title: 'Second',
        description: 'D2',
        price: 20,
        stock: 5,
        images: [],
        categoryId: 'c1',
        isActive: true,
      },
    ]);

    const recent = await catalogService.getRecentlyViewedProducts('viewer-1', 6);
    // Preserves Redis ZREVRANGE order (newest viewed first)
    expect(recent.map((p) => p.id)).toEqual(['p-2', 'p-1']);
  });

  it('projects VerifiedPurchase on payment.succeeded, enforces buyer-only reviews, updates avgRating/reviewsCount, and evicts Redis cache', async () => {
    await catalogService.handlePaymentSucceeded(
      {
        paymentId: 'pay-rev-1',
        orderId: 'ord-rev-1',
        userId: 'buyer-1',
        userEmail: 'buyer@shop.local',
        items: [
          {
            productId: 'prod-rev-1',
            productTitle: 'Keyboard',
            quantity: 1,
            unitPrice: 189,
          },
        ],
        amount: 189,
        transactionId: 'tx_rev_1',
        paidAt: new Date().toISOString(),
      },
      'trace-rev',
      'evt-pay-rev-1',
    );

    expect(mockPrisma.verifiedPurchase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_productId: { userId: 'buyer-1', productId: 'prod-rev-1' },
        },
      }),
    );

    // Non-buyer rejected with ForbiddenException
    mockPrisma.product.findUnique.mockResolvedValue({
      id: 'prod-rev-1',
      avgRating: 0,
      reviewsCount: 0,
    });
    mockPrisma.verifiedPurchase.findUnique.mockResolvedValueOnce(null);
    await expect(
      catalogService.createProductReview('prod-rev-1', 'stranger', 's@shop.local', {
        rating: 5,
        comment: 'Fake review',
      }),
    ).rejects.toThrow(ForbiddenException);

    // Verified buyer accepted, denormalized rating updated, Redis cache invalidated
    mockPrisma.verifiedPurchase.findUnique.mockResolvedValueOnce({
      id: 'vp-1',
      userId: 'buyer-1',
      productId: 'prod-rev-1',
    });
    mockPrisma.review.create.mockResolvedValueOnce({
      id: 'rev-1',
      productId: 'prod-rev-1',
      userId: 'buyer-1',
      userEmail: 'buyer@shop.local',
      rating: 5,
      comment: 'Awesome mechanical switches!',
      createdAt: new Date(),
    });
    mockPrisma.review.aggregate.mockResolvedValueOnce({
      _avg: { rating: 4.5 },
      _count: { id: 2 },
    });

    const created = await catalogService.createProductReview(
      'prod-rev-1',
      'buyer-1',
      'buyer@shop.local',
      { rating: 5, comment: 'Awesome mechanical switches!' },
    );
    expect(created.verifiedPurchase).toBe(true);
    expect(mockPrisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-rev-1' },
      data: { avgRating: 4.5, reviewsCount: 2 },
    });
    expect(mockRedis.del).toHaveBeenCalledWith('catalog:products:item:prod-rev-1');

    // Duplicate review rejected with ConflictException
    mockPrisma.verifiedPurchase.findUnique.mockResolvedValueOnce({ id: 'vp-1' });
    mockPrisma.review.create.mockRejectedValueOnce(
      Object.assign(new Error('Duplicate'), { code: 'P2002' }),
    );
    await expect(
      catalogService.createProductReview(
        'prod-rev-1',
        'buyer-1',
        'buyer@shop.local',
        { rating: 4, comment: 'Second review attempt' },
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('subscribes to Back-in-Stock alerts when stock=0 and emits catalog.product.restocked on 0 -> >0 transition', async () => {
    // Reject subscription when already in stock
    mockPrisma.product.findUnique.mockResolvedValueOnce({
      id: 'prod-in-stock',
      stock: 5,
    });
    await expect(
      catalogService.subscribeStockAlert('prod-in-stock', 'a@b.c', 'u-1'),
    ).rejects.toThrow(BadRequestException);

    // Subscribe when stock === 0
    mockPrisma.product.findUnique.mockResolvedValueOnce({
      id: 'prod-oos',
      stock: 0,
    });
    const sub = await catalogService.subscribeStockAlert(
      'prod-oos',
      'Alert@Shop.Local',
      'u-alert-1',
    );
    expect(sub).toEqual({
      subscribed: true,
      productId: 'prod-oos',
      email: 'alert@shop.local',
    });

    // Admin restocks 0 -> 12 -> emits catalog.product.restocked
    mockPrisma.product.findUnique
      .mockResolvedValueOnce({
        id: 'prod-oos',
        title: 'Sold-Out Monitor',
        description: 'Desc',
        price: 599,
        stock: 0,
        images: [],
        categoryId: 'cat-1',
        isActive: true,
        version: 1,
      })
      .mockResolvedValueOnce({
        id: 'prod-oos',
        title: 'Sold-Out Monitor',
        description: 'Desc',
        price: 599,
        stock: 12,
        images: [],
        categoryId: 'cat-1',
        isActive: true,
        version: 2,
      });
    mockPrisma.product.update.mockResolvedValueOnce({
      id: 'prod-oos',
      title: 'Sold-Out Monitor',
      description: 'Desc',
      price: 599,
      stock: 12,
      images: [],
      categoryId: 'cat-1',
      isActive: true,
      version: 2,
    });
    mockPrisma.stockAlertSubscription.findMany.mockResolvedValueOnce([
      { id: 'sub-1', userId: 'u-alert-1', email: 'alert@shop.local' },
    ]);

    await catalogService.updateProduct('prod-oos', { stock: 12 });

    expect(mockPrisma.stockAlertSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['sub-1'] } },
      }),
    );
    expect(mockRmqService.publish).toHaveBeenCalledWith(
      ROUTING_KEYS.PRODUCT_RESTOCKED,
      expect.objectContaining({
        productId: 'prod-oos',
        stock: 12,
        subscribers: [{ userId: 'u-alert-1', email: 'alert@shop.local' }],
      }),
      undefined,
    );
  });
});
