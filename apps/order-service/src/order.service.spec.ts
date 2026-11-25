import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { of } from 'rxjs';
import { UserRole } from '@shop/contracts';
import { OrderService } from './order.service';

describe('OrderService — Promo Code Calculation, Transactional Outbox & Saga Handlers', () => {
  let orderService: OrderService;
  let mockPrisma: any;
  let mockCartService: any;
  let mockRmqService: any;
  let mockCatalogClient: any;
  let mockInvoiceStorage: any;

  beforeEach(() => {
    mockPrisma = {
      $transaction: vi.fn(async (cb: any) => cb(mockPrisma)),
      order: {
        create: vi.fn(),
        updateMany: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      outbox: {
        create: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
      processedEvent: {
        create: vi.fn().mockResolvedValue({}),
      },
    };

    mockCartService = {
      getCart: vi.fn(),
      clearCart: vi.fn(),
    };

    mockRmqService = {
      publish: vi.fn().mockResolvedValue(true),
      subscribe: vi.fn().mockResolvedValue(undefined),
    };

    mockCatalogClient = {
      send: vi.fn(),
    };

    mockInvoiceStorage = {
      createPresignedDownloadUrl: vi.fn().mockResolvedValue({
        downloadUrl:
          'http://localhost:9000/invoices-private/invoices/invoice-ord-1.pdf?X-Amz-Expires=60&X-Amz-Signature=sig',
        fileName: 'invoice-ord-1.pdf',
        expiresInSeconds: 60,
      }),
      ensureFallbackInvoice: vi
        .fn()
        .mockResolvedValue('invoices/invoice-ord-1.pdf'),
    };

    orderService = new OrderService(
      mockPrisma,
      mockCartService,
      mockRmqService,
      mockCatalogClient,
      mockInvoiceStorage,
    );
  });

  describe('calculatePromoDiscount', () => {
    it('calculates a percentage discount accurately (e.g. 20% off $200 = $160)', () => {
      const result = orderService.calculatePromoDiscount({
        subtotal: 200,
        percentage: 20,
        fixedAmount: 0,
      });

      expect(result.subtotal).toBe(200);
      expect(result.discountAmount).toBe(40);
      expect(result.finalTotal).toBe(160);
    });

    it('calculates a fixed amount discount accurately (e.g. $25 off $189 = $164)', () => {
      const result = orderService.calculatePromoDiscount({
        subtotal: 189,
        percentage: 0,
        fixedAmount: 25,
      });

      expect(result.subtotal).toBe(189);
      expect(result.discountAmount).toBe(25);
      expect(result.finalTotal).toBe(164);
    });

    it('enforces minimum order amount constraint when specified', () => {
      expect(() =>
        orderService.calculatePromoDiscount({
          subtotal: 45,
          percentage: 15,
          minOrderAmount: 100,
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects non-positive subtotal', () => {
      expect(() =>
        orderService.calculatePromoDiscount({
          subtotal: 0,
          percentage: 10,
        }),
      ).toThrow(BadRequestException);
    });

    it('caps total discount at the order subtotal so finalTotal never drops below 0', () => {
      const result = orderService.calculatePromoDiscount({
        subtotal: 30,
        percentage: 50,
        fixedAmount: 50,
      });

      expect(result.discountAmount).toBe(30);
      expect(result.finalTotal).toBe(0);
    });
  });

  describe('checkout & Transactional Outbox Pattern', () => {
    it('writes Order and Outbox event atomically in a single transaction and relays via Outbox worker', async () => {
      mockCartService.getCart.mockResolvedValue({
        userId: 'user-1',
        subtotal: 200,
        items: [
          {
            productId: 'prod-1',
            productTitle: 'Pro Keyboard',
            unitPrice: 200,
            quantity: 1,
          },
        ],
      });

      mockCatalogClient.send.mockImplementation((pattern: string) => {
        if (pattern === 'catalog.stock.check') {
          return of({
            available: true,
            quotedItems: [
              {
                productId: 'prod-1',
                productTitle: 'Pro Keyboard',
                unitPrice: 200,
                quantity: 1,
              },
            ],
          });
        }
        if (pattern === 'catalog.discounts.validate') {
          return of({
            valid: true,
            code: 'WELCOME20',
            percentage: 20,
            fixedAmount: 0,
          });
        }
        return of({});
      });

      const createdAt = new Date();
      mockPrisma.order.create.mockResolvedValue({
        id: 'order-uuid-1',
        userId: 'user-1',
        status: 'PENDING',
        totalAmount: 160,
        discountCode: 'WELCOME20',
        createdAt,
        items: [
          {
            id: 'item-1',
            orderId: 'order-uuid-1',
            productId: 'prod-1',
            productTitle: 'Pro Keyboard',
            quantity: 1,
            unitPrice: 200,
          },
        ],
      });

      mockPrisma.outbox.findMany.mockResolvedValue([
        {
          id: 'outbox-uuid-1',
          aggregateId: 'order-uuid-1',
          eventType: 'order.created',
          payload: {
            orderId: 'order-uuid-1',
            userId: 'user-1',
            totalAmount: 160,
          },
          traceId: 'trace-123',
          published: false,
        },
      ]);

      const order = await orderService.checkout(
        'user-1',
        'customer@example.com',
        'WELCOME20',
        'trace-123',
      );

      expect(order.status).toBe('PENDING');
      expect(order.totalAmount).toBe(160);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
      expect(mockPrisma.outbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            aggregateId: 'order-uuid-1',
            eventType: 'order.created',
            published: false,
          }),
        }),
      );
      expect(mockCartService.clearCart).toHaveBeenCalledWith('user-1');
      expect(mockRmqService.publish).toHaveBeenCalledWith(
        'order.created',
        expect.objectContaining({
          orderId: 'order-uuid-1',
          totalAmount: 160,
        }),
        'trace-123',
        'outbox-uuid-1',
      );
      expect(mockPrisma.outbox.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'outbox-uuid-1' },
          data: expect.objectContaining({ published: true }),
        }),
      );
    });

    it('rejects checkout with empty cart or invalid promo code', async () => {
      mockCartService.getCart.mockResolvedValue({ userId: 'u1', items: [] });
      await expect(orderService.checkout('u1')).rejects.toThrow(
        BadRequestException,
      );

      mockCartService.getCart.mockResolvedValue({
        userId: 'u1',
        subtotal: 100,
        items: [{ productId: 'p1', productTitle: 'T', unitPrice: 100, quantity: 1 }],
      });
      mockCatalogClient.send.mockImplementation((pattern: string) => {
        if (pattern === 'catalog.stock.check') {
          return of({
            available: true,
            quotedItems: [
              {
                productId: 'p1',
                productTitle: 'T',
                unitPrice: 100,
                quantity: 1,
              },
            ],
          });
        }
        return of({ valid: false, reason: 'Expired promo' });
      });

      await expect(
        orderService.checkout('u1', 'a@b.c', 'EXPIRED'),
      ).rejects.toThrow(BadRequestException);
    });

    it('prevents client-side price tampering by pricing orders strictly from authoritative catalog-service quotes', async () => {
      // Attacker submits tampered $0.01 unitPrice in cart
      mockCartService.getCart.mockResolvedValue({
        userId: 'attacker-1',
        subtotal: 0.01,
        items: [
          {
            productId: 'prod-macbook',
            productTitle: 'Tampered Title',
            unitPrice: 0.01,
            quantity: 2,
          },
        ],
      });

      // Authoritative catalog_db price is $1999.00 each
      mockCatalogClient.send.mockImplementation((pattern: string) => {
        if (pattern === 'catalog.stock.check') {
          return of({
            available: true,
            quotedItems: [
              {
                productId: 'prod-macbook',
                productTitle: 'MacBook Pro 16',
                unitPrice: 1999,
                quantity: 2,
              },
            ],
          });
        }
        return of({});
      });

      mockPrisma.order.create.mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: 'order-secure-1',
          userId: data.userId,
          status: data.status,
          totalAmount: data.totalAmount,
          discountCode: data.discountCode,
          createdAt: new Date(),
          items: data.items.create.map((i: any, idx: number) => ({
            id: `item-${idx}`,
            orderId: 'order-secure-1',
            ...i,
          })),
        }),
      );

      const order = await orderService.checkout('attacker-1', 'a@evil.test');
      expect(order.totalAmount).toBe(3998);
      expect(order.items[0].unitPrice).toBe(1999);
      expect(order.items[0].productTitle).toBe('MacBook Pro 16');
    });

    it('uses PostgreSQL FOR UPDATE SKIP LOCKED when $queryRaw is available for safe multi-replica Outbox polling', async () => {
      mockPrisma.$queryRaw = vi.fn().mockResolvedValue([
        {
          id: 'outbox-locked-1',
          eventType: 'order.created',
          payload: { orderId: 'ord-locked-1' },
          traceId: 'trace-locked',
        },
      ]);

      const count = await orderService.processOutboxBatch();
      expect(count).toBe(1);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(mockRmqService.publish).toHaveBeenCalledWith(
        'order.created',
        { orderId: 'ord-locked-1' },
        'trace-locked',
        'outbox-locked-1',
      );
      expect(mockPrisma.outbox.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'outbox-locked-1' },
          data: expect.objectContaining({ published: true }),
        }),
      );
    });
  });

  describe('Saga Event Handlers & Order Queries', () => {
    it('transitions order status on payment.succeeded, payment.failed, and catalog.stock.failed', async () => {
      await orderService.onModuleInit();
      expect(mockRmqService.subscribe).toHaveBeenCalledTimes(5);

      await orderService.handlePaymentSucceeded({
        paymentId: 'pay-1',
        orderId: 'ord-1',
        userId: 'u-1',
        amount: 100,
        transactionId: 'tx_1',
        paidAt: new Date().toISOString(),
      });
      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'ord-1' },
        data: { status: 'PAID' },
      });

      await orderService.handlePaymentFailed({
        paymentId: 'pay-2',
        orderId: 'ord-2',
        userId: 'u-1',
        items: [],
        amount: 100,
        reason: 'Card declined',
        failedAt: new Date().toISOString(),
      });
      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'ord-2' },
        data: { status: 'FAILED' },
      });

      await orderService.handleStockFailed({
        orderId: 'ord-3',
        userId: 'u-1',
        reason: 'Out of stock',
        failedAt: new Date().toISOString(),
      });
      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'ord-3' },
        data: { status: 'CANCELLED' },
      });
    });

    it('enforces Inbox Pattern deduplication when RabbitMQ redelivers an already-processed event (P2002)', async () => {
      const p2002 = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
      });
      mockPrisma.processedEvent.create.mockRejectedValue(p2002);

      await orderService.handlePaymentSucceeded(
        {
          paymentId: 'pay-dup',
          orderId: 'ord-dup',
          userId: 'u-1',
          amount: 100,
          transactionId: 'tx_dup',
          paidAt: new Date().toISOString(),
        },
        'trace-dup',
        'evt-dup-1',
      );

      await orderService.handlePaymentFailed(
        {
          paymentId: 'pay-dup-2',
          orderId: 'ord-dup-2',
          userId: 'u-1',
          items: [],
          amount: 100,
          reason: 'Declined',
          failedAt: new Date().toISOString(),
        },
        'trace-dup',
        'evt-dup-2',
      );

      await orderService.handleStockFailed(
        {
          orderId: 'ord-dup-3',
          userId: 'u-1',
          reason: 'Out of stock',
          failedAt: new Date().toISOString(),
        },
        'trace-dup',
        'evt-dup-3',
      );

      expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
      expect(mockRmqService.publish).not.toHaveBeenCalled();
    });

    it('fetches user orders and single order by ID', async () => {
      const sampleOrder = {
        id: 'ord-10',
        userId: 'u-1',
        status: 'PAID',
        totalAmount: 99,
        discountCode: null,
        createdAt: new Date(),
        items: [],
      };
      mockPrisma.order.findMany.mockResolvedValue([sampleOrder]);
      mockPrisma.order.findUnique.mockResolvedValue(sampleOrder);

      const list = await orderService.getUserOrders('u-1');
      expect(list).toHaveLength(1);

      const single = await orderService.getOrderById('ord-10', 'u-1');
      expect(single.id).toBe('ord-10');

      mockPrisma.order.findUnique.mockResolvedValue(null);
      await expect(
        orderService.getOrderById('missing', 'u-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('initiates Refund Saga (PAID -> REFUNDING + Outbox) and transitions to REFUNDED on payment.refunded with Inbox deduplication', async () => {
      const paidOrder = {
        id: 'ord-refund-1',
        userId: 'u-1',
        status: 'PAID',
        totalAmount: 199.99,
        discountCode: null,
        createdAt: new Date(),
        items: [
          {
            id: 'item-1',
            orderId: 'ord-refund-1',
            productId: 'prod-1',
            productTitle: 'Keyboard',
            quantity: 1,
            unitPrice: 199.99,
          },
        ],
      };

      mockPrisma.order.findUnique.mockResolvedValue(paidOrder);
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.outbox.findMany.mockResolvedValue([
        {
          id: 'outbox-refund-1',
          aggregateId: 'ord-refund-1',
          eventType: 'order.refund_requested',
          payload: { orderId: 'ord-refund-1', amount: 199.99 },
          traceId: 'trace-refund',
          published: false,
        },
      ]);

      const refunding = await orderService.requestRefund(
        'ord-refund-1',
        'u-1',
        UserRole.CUSTOMER,
        'u1@shop.local',
        'Changed mind',
        'trace-refund',
      );

      expect(refunding.status).toBe('REFUNDING');
      expect(mockPrisma.outbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            aggregateId: 'ord-refund-1',
            eventType: 'order.refund_requested',
            published: false,
          }),
        }),
      );
      expect(mockRmqService.publish).toHaveBeenCalledWith(
        'order.refund_requested',
        expect.objectContaining({ orderId: 'ord-refund-1' }),
        'trace-refund',
        'outbox-refund-1',
      );

      // Rejects unauthorized non-owner CUSTOMER
      await expect(
        orderService.requestRefund('ord-refund-1', 'other-user', UserRole.CUSTOMER),
      ).rejects.toThrow(ForbiddenException);

      // Rejects already REFUNDING / REFUNDED
      mockPrisma.order.findUnique.mockResolvedValue({
        ...paidOrder,
        status: 'REFUNDING',
      });
      await expect(
        orderService.requestRefund('ord-refund-1', 'u-1', UserRole.CUSTOMER),
      ).rejects.toThrow(ConflictException);

      // Rejects non-PAID status (e.g. PENDING)
      mockPrisma.order.findUnique.mockResolvedValue({
        ...paidOrder,
        status: 'PENDING',
      });
      await expect(
        orderService.requestRefund('ord-refund-1', 'u-1', UserRole.CUSTOMER),
      ).rejects.toThrow(BadRequestException);

      // Transitions to REFUNDED on payment.refunded
      mockPrisma.order.updateMany.mockClear();
      await orderService.handlePaymentRefunded(
        {
          paymentId: 'pay-1',
          orderId: 'ord-refund-1',
          userId: 'u-1',
          items: [],
          amount: 199.99,
          refundTransactionId: 'ref_abc123',
          reason: 'Changed mind',
          refundedAt: new Date().toISOString(),
        },
        'trace-refund',
        'evt-refund-1',
      );
      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'ord-refund-1' },
        data: { status: 'REFUNDED' },
      });

      // Deduplicates duplicate payment.refunded via Inbox P2002
      mockPrisma.order.updateMany.mockClear();
      mockPrisma.processedEvent.create.mockRejectedValueOnce(
        Object.assign(new Error('Duplicate'), { code: 'P2002' }),
      );
      await orderService.handlePaymentRefunded(
        {
          paymentId: 'pay-1',
          orderId: 'ord-refund-1',
          userId: 'u-1',
          items: [],
          amount: 199.99,
          refundTransactionId: 'ref_abc123',
          reason: 'Changed mind',
          refundedAt: new Date().toISOString(),
        },
        'trace-refund',
        'evt-refund-1',
      );
      expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('enforces IDOR protection on getInvoiceDownloadUrl and issues 60s Presigned GET URL for paid orders', async () => {
      const paidOrder = {
        id: 'ord-inv-1',
        userId: 'owner-1',
        status: 'PAID',
        totalAmount: 149.99,
        invoiceKey: 'invoices/invoice-ord-inv-1.pdf',
        createdAt: new Date(),
        items: [],
      };

      mockPrisma.order.findUnique.mockResolvedValue(paidOrder);

      // IDOR check: different CUSTOMER user is rejected with 403 Forbidden
      await expect(
        orderService.getInvoiceDownloadUrl(
          'ord-inv-1',
          'attacker-2',
          UserRole.CUSTOMER,
        ),
      ).rejects.toThrow(ForbiddenException);

      // Owner receives 60s Presigned GET URL
      const res = await orderService.getInvoiceDownloadUrl(
        'ord-inv-1',
        'owner-1',
        UserRole.CUSTOMER,
      );
      expect(res.expiresInSeconds).toBe(60);
      expect(res.downloadUrl).toContain('X-Amz-Expires=60');

      // Pending order rejected with 400 BadRequest
      mockPrisma.order.findUnique.mockResolvedValueOnce({
        ...paidOrder,
        status: 'PENDING',
      });
      await expect(
        orderService.getInvoiceDownloadUrl(
          'ord-inv-1',
          'owner-1',
          UserRole.CUSTOMER,
        ),
      ).rejects.toThrow(BadRequestException);

      // Fallback generation when invoiceKey is null
      mockPrisma.order.findUnique.mockResolvedValueOnce({
        ...paidOrder,
        invoiceKey: null,
      });
      await orderService.getInvoiceDownloadUrl(
        'ord-inv-1',
        'admin-99',
        UserRole.ADMIN,
      );
      expect(mockInvoiceStorage.ensureFallbackInvoice).toHaveBeenCalledTimes(1);

      // Inbox-protected invoice.generated event updates invoiceKey
      mockPrisma.order.updateMany.mockClear();
      await orderService.handleInvoiceGenerated(
        {
          orderId: 'ord-inv-1',
          userId: 'owner-1',
          invoiceKey: 'invoices/invoice-ord-inv-1.pdf',
          generatedAt: new Date().toISOString(),
        },
        'trace-inv',
        'evt-inv-1',
      );
      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'ord-inv-1' },
        data: { invoiceKey: 'invoices/invoice-ord-inv-1.pdf' },
      });
    });
  });
});
