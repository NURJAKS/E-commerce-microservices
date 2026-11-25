import { BadRequestException, ForbiddenException } from '@nestjs/common';
import Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@shop/contracts';
import { ROUTING_KEYS } from '@shop/rmq';
import { PaymentService } from './payment.service';

describe('PaymentService — Idempotent Refund Saga Handler', () => {
  let paymentService: PaymentService;
  let mockPrisma: any;
  let mockRmqService: any;

  beforeEach(() => {
    mockPrisma = {
      $transaction: vi.fn(async (cb: any) => cb(mockPrisma)),
      payment: {
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      processedEvent: {
        create: vi.fn().mockResolvedValue({}),
      },
    };

    mockRmqService = {
      publish: vi.fn().mockResolvedValue(true),
      subscribe: vi.fn().mockResolvedValue(undefined),
    };

    paymentService = new PaymentService(mockPrisma, mockRmqService);
  });

  it('processes order.refund_requested, transitions SUCCESS -> REFUNDED, and publishes payment.refunded', async () => {
    mockPrisma.payment.findFirst
      .mockResolvedValueOnce(null) // no existing REFUNDED payment
      .mockResolvedValueOnce({
        id: 'pay-1',
        orderId: 'ord-1',
        userId: 'user-1',
        amount: 250,
        status: 'SUCCESS',
        transactionId: 'tx_orig',
      });

    await paymentService.handleOrderRefundRequested(
      {
        orderId: 'ord-1',
        userId: 'user-1',
        userEmail: 'buyer@shop.local',
        items: [
          {
            productId: 'prod-1',
            productTitle: 'Keyboard',
            quantity: 1,
            unitPrice: 250,
          },
        ],
        amount: 250,
        reason: 'Changed mind',
        requestedAt: new Date().toISOString(),
      },
      'trace-ref-1',
      'evt-ref-1',
    );

    expect(mockPrisma.processedEvent.create).toHaveBeenCalledWith({
      data: {
        eventId: 'evt-ref-1',
        eventType: ROUTING_KEYS.ORDER_REFUND_REQUESTED,
      },
    });
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay-1', status: 'SUCCESS' },
        data: expect.objectContaining({
          status: 'REFUNDED',
          refundTransactionId: expect.stringMatching(/^ref_/),
        }),
      }),
    );
    expect(mockRmqService.publish).toHaveBeenCalledWith(
      ROUTING_KEYS.PAYMENT_REFUNDED,
      expect.objectContaining({
        orderId: 'ord-1',
        paymentId: 'pay-1',
        amount: 250,
        refundTransactionId: expect.stringMatching(/^ref_/),
      }),
      'trace-ref-1',
    );
  });

  it('skips duplicate refund request when order is already REFUNDED (no double refund)', async () => {
    mockPrisma.payment.findFirst.mockResolvedValueOnce({
      id: 'pay-1',
      orderId: 'ord-1',
      status: 'REFUNDED',
      refundTransactionId: 'ref_existing',
    });

    await paymentService.handleOrderRefundRequested(
      {
        orderId: 'ord-1',
        userId: 'user-1',
        items: [],
        amount: 250,
        reason: 'Duplicate click',
        requestedAt: new Date().toISOString(),
      },
      'trace-dup',
      'evt-ref-dup',
    );

    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(mockRmqService.publish).not.toHaveBeenCalled();
  });

  describe('Stripe Webhook HMAC Signature Verification & Idempotent Deduplication', () => {
    const webhookSecret = 'whsec_test_secret_1234567890';

    beforeEach(() => {
      process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    });

    it('rejects tampered payloads or invalid Stripe-Signature headers with BadRequestException', async () => {
      const payload = JSON.stringify({
        id: 'evt_bad_sig',
        object: 'event',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_test_1' } },
      });

      await expect(
        paymentService.handleStripeWebhook(payload, 't=123,v1=invalid_hmac'),
      ).rejects.toThrow(BadRequestException);
    });

    it('verifies valid HMAC Stripe-Signature on raw body, settles checkout.session.completed, and deduplicates redeliveries', async () => {
      const payload = JSON.stringify({
        id: 'evt_test_success_1',
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_123',
            payment_intent: 'pi_test_999',
            payment_status: 'paid',
            metadata: {
              orderId: 'ord-stripe-1',
              userId: 'user-stripe-1',
              userEmail: 'stripe@shop.local',
            },
          },
        },
      });

      const validSignature = Stripe.webhooks.generateTestHeaderString({
        payload,
        secret: webhookSecret,
      });

      mockPrisma.payment.findFirst.mockResolvedValueOnce({
        id: 'pay-stripe-1',
        orderId: 'ord-stripe-1',
        userId: 'user-stripe-1',
        userEmail: 'stripe@shop.local',
        amount: 199.5,
        status: 'PENDING',
        itemsPayload: [
          {
            productId: 'prod-1',
            productTitle: 'Keyboard',
            quantity: 1,
            unitPrice: 199.5,
          },
        ],
      });

      const firstRes = await paymentService.handleStripeWebhook(
        payload,
        validSignature,
        'trace-stripe-1',
      );

      expect(firstRes).toEqual({
        received: true,
        deduplicated: false,
        eventId: 'evt_test_success_1',
        eventType: 'checkout.session.completed',
      });
      expect(mockPrisma.processedEvent.create).toHaveBeenCalledWith({
        data: {
          eventId: 'stripe:evt_test_success_1',
          eventType: 'checkout.session.completed',
        },
      });
      expect(mockRmqService.publish).toHaveBeenCalledWith(
        ROUTING_KEYS.PAYMENT_SUCCEEDED,
        expect.objectContaining({
          orderId: 'ord-stripe-1',
          transactionId: 'pi_test_999',
          amount: 199.5,
        }),
        'trace-stripe-1',
      );

      // Simulate Stripe sending a duplicate webhook with the exact same event ID
      mockRmqService.publish.mockClear();
      mockPrisma.processedEvent.create.mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );

      const dupRes = await paymentService.handleStripeWebhook(
        payload,
        validSignature,
        'trace-stripe-dup',
      );
      expect(dupRes).toEqual({
        received: true,
        deduplicated: true,
        eventId: 'evt_test_success_1',
        eventType: 'checkout.session.completed',
      });
      expect(mockRmqService.publish).not.toHaveBeenCalled();
    });

    it('publishes payment.failed on checkout.session.expired to trigger Saga stock rollback', async () => {
      const payload = JSON.stringify({
        id: 'evt_test_expired_1',
        object: 'event',
        type: 'checkout.session.expired',
        data: {
          object: {
            id: 'cs_test_expired',
            metadata: { orderId: 'ord-stripe-exp' },
          },
        },
      });

      const validSignature = Stripe.webhooks.generateTestHeaderString({
        payload,
        secret: webhookSecret,
      });

      mockPrisma.payment.findFirst.mockResolvedValueOnce({
        id: 'pay-exp-1',
        orderId: 'ord-stripe-exp',
        userId: 'user-exp',
        userEmail: 'exp@shop.local',
        amount: 99,
        status: 'PENDING',
        itemsPayload: [
          {
            productId: 'prod-exp',
            productTitle: 'Mouse',
            quantity: 1,
            unitPrice: 99,
          },
        ],
      });

      const res = await paymentService.handleStripeWebhook(
        payload,
        validSignature,
        'trace-exp',
      );

      expect(res.received).toBe(true);
      expect(mockRmqService.publish).toHaveBeenCalledWith(
        ROUTING_KEYS.PAYMENT_FAILED,
        expect.objectContaining({
          orderId: 'ord-stripe-exp',
          reason: 'Stripe checkout.session.expired',
        }),
        'trace-exp',
      );
    });
  });

  describe('IDOR Protection on getPaymentByOrderId', () => {
    it('blocks non-owner CUSTOMER with ForbiddenException while allowing owner and ADMIN', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue({
        id: 'pay-idor-1',
        orderId: 'ord-idor-1',
        userId: 'owner-user',
        amount: 149.99,
        status: 'SUCCESS',
        provider: 'MOCK',
        transactionId: 'tx_idor_1',
        stripeSessionId: null,
        checkoutUrl: null,
        refundTransactionId: null,
        refundedAt: null,
        createdAt: new Date(),
      });

      await expect(
        paymentService.getPaymentByOrderId(
          'ord-idor-1',
          'attacker-user',
          UserRole.CUSTOMER,
        ),
      ).rejects.toThrow(ForbiddenException);

      const ownerRes = await paymentService.getPaymentByOrderId(
        'ord-idor-1',
        'owner-user',
        UserRole.CUSTOMER,
      );
      expect(ownerRes?.id).toBe('pay-idor-1');

      const adminRes = await paymentService.getPaymentByOrderId(
        'ord-idor-1',
        'admin-user',
        UserRole.ADMIN,
      );
      expect(adminRes?.id).toBe('pay-idor-1');
    });
  });
});
