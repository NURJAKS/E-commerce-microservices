import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { of } from 'rxjs';
import { OrderService } from './order.service';

describe('OrderService — Promo Code Calculation, Transactional Outbox & Saga Handlers', () => {
  let orderService: OrderService;
  let mockPrisma: any;
  let mockCartService: any;
  let mockRmqService: any;
  let mockCatalogClient: any;

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

    orderService = new OrderService(
      mockPrisma,
      mockCartService,
      mockRmqService,
      mockCatalogClient,
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
          return of({ available: true });
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
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
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
        if (pattern === 'catalog.stock.check') return of({ available: true });
        return of({ valid: false, reason: 'Expired promo' });
      });

      await expect(
        orderService.checkout('u1', 'a@b.c', 'EXPIRED'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Saga Event Handlers & Order Queries', () => {
    it('transitions order status on payment.succeeded, payment.failed, and catalog.stock.failed', async () => {
      await orderService.onModuleInit();
      expect(mockRmqService.subscribe).toHaveBeenCalledTimes(3);

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
  });
});
