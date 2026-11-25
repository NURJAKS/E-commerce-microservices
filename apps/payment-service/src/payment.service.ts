import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import * as crypto from 'crypto';
import Stripe from 'stripe';
import { isPrismaUniqueConstraintError } from '@shop/common';
import {
  OrderRefundRequestedEvent,
  PaymentDto,
  PaymentFailedEvent,
  PaymentRefundedEvent,
  PaymentStatus,
  PaymentSucceededEvent,
  SagaOrderItem,
  StockReservedEvent,
  UserRole,
} from '@shop/contracts';
import { RabbitMQService, ROUTING_KEYS } from '@shop/rmq';
import { PrismaService } from './prisma.service';

@Injectable()
export class PaymentService implements OnModuleInit {
  private readonly logger = new Logger(PaymentService.name);
  private readonly stripe: Stripe | null;
  private readonly frontendUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rmqService: RabbitMQService,
  ) {
    const secretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
    this.stripe = secretKey ? new Stripe(secretKey) : null;
    this.frontendUrl = (
      process.env.FRONTEND_PUBLIC_URL || 'http://localhost'
    ).replace(/\/$/, '');

    if (this.stripe) {
      this.logger.log(
        'Stripe Test Mode enabled — checkout sessions will redirect to Stripe Checkout and settle via signed webhooks',
      );
    } else {
      this.logger.log(
        'STRIPE_SECRET_KEY not set — running in deterministic Mock PSP mode (signed Stripe webhooks still supported when STRIPE_WEBHOOK_SECRET is configured)',
      );
    }
  }

  async onModuleInit(): Promise<void> {
    await this.rmqService.subscribe<StockReservedEvent>(
      'payment.stock_reserved.queue',
      [ROUTING_KEYS.STOCK_RESERVED],
      async (event, _rk, traceId) => this.handleStockReserved(event, traceId),
    );

    await this.rmqService.subscribe<OrderRefundRequestedEvent>(
      'payment.refund_requested.queue',
      [ROUTING_KEYS.ORDER_REFUND_REQUESTED],
      async (event, _rk, traceId, eventId) =>
        this.handleOrderRefundRequested(event, traceId, eventId),
    );
  }

  async handleStockReserved(
    event: StockReservedEvent,
    traceId?: string,
  ): Promise<void> {
    this.logger.log(
      `[Saga] [traceId=${traceId || 'n/a'}] Processing payment for order ${event.orderId} ($${event.totalAmount})`,
    );

    // Consumer-level idempotency: prevent double-charging if RabbitMQ redelivers an event (At-Least-Once Delivery)
    const existingSuccess = await this.prisma.payment.findFirst({
      where: { orderId: event.orderId, status: 'SUCCESS' },
    });
    if (existingSuccess) {
      this.logger.warn(
        `[Idempotency] Order ${event.orderId} already has a successful payment (${existingSuccess.transactionId}) — skipping duplicate charge`,
      );
      return;
    }

    // Real Stripe Checkout Test Mode path (asynchronous settlement via signed webhook)
    if (this.stripe) {
      const existingStripeSession = await this.prisma.payment.findFirst({
        where: {
          orderId: event.orderId,
          provider: 'STRIPE',
          status: 'PENDING',
        },
      });
      if (existingStripeSession?.stripeSessionId) {
        this.logger.warn(
          `[Idempotency] Stripe session ${existingStripeSession.stripeSessionId} already created for order ${event.orderId}`,
        );
        return;
      }

      const unitAmountCents = Math.max(50, Math.round(event.totalAmount * 100));
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          payment_method_types: ['card'],
          customer_email: event.userEmail || undefined,
          line_items: [
            {
              price_data: {
                currency: 'usd',
                unit_amount: unitAmountCents,
                product_data: {
                  name: `NovaShop Order #${event.orderId.slice(0, 8)}`,
                  description: event.items
                    .map((i) => `${i.productTitle} x${i.quantity}`)
                    .join(', ')
                    .slice(0, 250),
                },
              },
              quantity: 1,
            },
          ],
          metadata: {
            orderId: event.orderId,
            userId: event.userId,
            userEmail: event.userEmail || '',
          },
          success_url: `${this.frontendUrl}/orders/${event.orderId}?stripe=success`,
          cancel_url: `${this.frontendUrl}/orders/${event.orderId}?stripe=cancelled`,
        },
        {
          idempotencyKey: `checkout-session-${event.orderId}`,
        },
      );

      await this.prisma.payment.create({
        data: {
          orderId: event.orderId,
          userId: event.userId,
          userEmail: event.userEmail || null,
          amount: event.totalAmount,
          status: 'PENDING',
          provider: 'STRIPE',
          stripeSessionId: session.id,
          checkoutUrl: session.url || null,
          itemsPayload: event.items as any,
        },
      });

      this.logger.log(
        `[Stripe] [traceId=${traceId || 'n/a'}] Created Stripe Checkout session ${session.id} for order ${event.orderId} — awaiting signed webhook`,
      );
      return;
    }

    // Fallback deterministic mock PSP path (zero external API keys required for local demo/CI)
    const pendingPayment = await this.prisma.payment.create({
      data: {
        orderId: event.orderId,
        userId: event.userId,
        userEmail: event.userEmail || null,
        amount: event.totalAmount,
        status: 'PENDING',
        provider: 'MOCK',
        itemsPayload: event.items as any,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    const shouldFail =
      event.discountCode?.toUpperCase() === 'FAIL_PAYMENT' ||
      event.totalAmount > 999999;

    if (shouldFail) {
      await this.prisma.payment.update({
        where: { id: pendingPayment.id },
        data: { status: 'FAILED' },
      });

      const failedEvent: PaymentFailedEvent = {
        paymentId: pendingPayment.id,
        orderId: event.orderId,
        userId: event.userId,
        userEmail: event.userEmail,
        items: event.items,
        amount: event.totalAmount,
        reason: 'Payment declined by mock gateway (FAIL_PAYMENT trigger)',
        failedAt: new Date().toISOString(),
      };

      await this.rmqService.publish(
        ROUTING_KEYS.PAYMENT_FAILED,
        failedEvent,
        traceId,
      );
      return;
    }

    const transactionId = `tx_${crypto.randomBytes(8).toString('hex')}`;
    const updatedPayment = await this.prisma.payment.update({
      where: { id: pendingPayment.id },
      data: {
        status: 'SUCCESS',
        transactionId,
      },
    });

    const succeededEvent: PaymentSucceededEvent = {
      paymentId: updatedPayment.id,
      orderId: event.orderId,
      userId: event.userId,
      userEmail: event.userEmail,
      items: event.items,
      amount: Number(updatedPayment.amount),
      transactionId,
      paidAt: new Date().toISOString(),
    };

    await this.rmqService.publish(
      ROUTING_KEYS.PAYMENT_SUCCEEDED,
      succeededEvent,
      traceId,
    );
  }

  /**
   * Processes asynchronous Stripe webhooks:
   * 1. Verifies cryptographic HMAC-SHA256 `Stripe-Signature` on the exact raw HTTP body bytes.
   * 2. Deduplicates duplicate Stripe webhook deliveries atomically via `ProcessedEvent` PK (Inbox Pattern).
   * 3. Emits `payment.succeeded` or `payment.failed` to drive the Choreography Saga.
   */
  async handleStripeWebhook(
    rawBody: string,
    signature: string,
    traceId?: string,
  ): Promise<{
    received: boolean;
    deduplicated?: boolean;
    eventId: string;
    eventType: string;
  }> {
    const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!webhookSecret) {
      throw new BadRequestException(
        'STRIPE_WEBHOOK_SECRET is not configured on payment-service',
      );
    }

    let stripeEvent: Stripe.Event;
    try {
      stripeEvent = Stripe.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch (err: any) {
      this.logger.warn(
        `[Stripe Webhook] [traceId=${traceId || 'n/a'}] Signature verification failed: ${err?.message || err}`,
      );
      throw new BadRequestException(
        `Invalid Stripe webhook signature: ${err?.message || 'verification failed'}`,
      );
    }

    const inboxEventId = `stripe:${stripeEvent.id}`;
    let paymentToPublish:
      | { kind: 'SUCCEEDED'; payload: PaymentSucceededEvent }
      | { kind: 'FAILED'; payload: PaymentFailedEvent }
      | null = null;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            eventId: inboxEventId,
            eventType: stripeEvent.type,
          },
        });

        if (stripeEvent.type === 'checkout.session.completed') {
          const session = stripeEvent.data.object as Stripe.Checkout.Session;
          const orderId = session.metadata?.orderId;
          const payment = await tx.payment.findFirst({
            where: session.id
              ? {
                  OR: [
                    { stripeSessionId: session.id },
                    ...(orderId ? [{ orderId }] : []),
                  ],
                }
              : { orderId },
            orderBy: { createdAt: 'desc' },
          });

          if (!payment) {
            this.logger.warn(
              `[Stripe Webhook] No matching Payment row found for session ${session.id} / order ${orderId || 'n/a'}`,
            );
            return;
          }

          const paymentIntentId =
            typeof session.payment_intent === 'string'
              ? session.payment_intent
              : session.payment_intent?.id || null;
          const txId = paymentIntentId || session.id;

          const updated = await tx.payment.updateMany({
            where: { id: payment.id, status: 'PENDING' },
            data: {
              status: 'SUCCESS',
              transactionId: txId,
              stripePaymentIntentId: paymentIntentId,
            },
          });

          if (updated.count > 0) {
            const items = Array.isArray(payment.itemsPayload)
              ? (payment.itemsPayload as unknown as SagaOrderItem[])
              : [];

            paymentToPublish = {
              kind: 'SUCCEEDED',
              payload: {
                paymentId: payment.id,
                orderId: payment.orderId,
                userId: payment.userId,
                userEmail:
                  payment.userEmail ||
                  session.customer_details?.email ||
                  session.metadata?.userEmail ||
                  undefined,
                items,
                amount: Number(payment.amount),
                transactionId: txId,
                paidAt: new Date().toISOString(),
              },
            };
          }
        } else if (
          stripeEvent.type === 'checkout.session.expired' ||
          stripeEvent.type === 'checkout.session.async_payment_failed' ||
          stripeEvent.type === 'payment_intent.payment_failed'
        ) {
          const obj = stripeEvent.data.object as any;
          const sessionId =
            stripeEvent.type.startsWith('checkout.session.')
              ? obj.id
              : undefined;
          const orderId = obj.metadata?.orderId;

          const payment = await tx.payment.findFirst({
            where: sessionId
              ? {
                  OR: [
                    { stripeSessionId: sessionId },
                    ...(orderId ? [{ orderId }] : []),
                  ],
                }
              : { orderId },
            orderBy: { createdAt: 'desc' },
          });

          if (!payment) {
            this.logger.warn(
              `[Stripe Webhook] No matching Payment row found for failed event ${stripeEvent.id}`,
            );
            return;
          }

          const updated = await tx.payment.updateMany({
            where: { id: payment.id, status: 'PENDING' },
            data: { status: 'FAILED' },
          });

          if (updated.count > 0) {
            const items = Array.isArray(payment.itemsPayload)
              ? (payment.itemsPayload as unknown as SagaOrderItem[])
              : [];
            const reason =
              obj.last_payment_error?.message ||
              `Stripe ${stripeEvent.type}`;

            paymentToPublish = {
              kind: 'FAILED',
              payload: {
                paymentId: payment.id,
                orderId: payment.orderId,
                userId: payment.userId,
                userEmail:
                  payment.userEmail || obj.metadata?.userEmail || undefined,
                items,
                amount: Number(payment.amount),
                reason,
                failedAt: new Date().toISOString(),
              },
            };
          }
        }
      });
    } catch (err: any) {
      if (isPrismaUniqueConstraintError(err)) {
        this.logger.warn(
          `[Stripe Webhook Inbox] [traceId=${traceId || 'n/a'}] Duplicate Stripe webhook "${stripeEvent.id}" (${stripeEvent.type}) already processed — returning 200 OK`,
        );
        return {
          received: true,
          deduplicated: true,
          eventId: stripeEvent.id,
          eventType: stripeEvent.type,
        };
      }
      throw err;
    }

    if (paymentToPublish) {
      const outcome = paymentToPublish as
        | { kind: 'SUCCEEDED'; payload: PaymentSucceededEvent }
        | { kind: 'FAILED'; payload: PaymentFailedEvent };

      if (outcome.kind === 'SUCCEEDED') {
        await this.rmqService.publish(
          ROUTING_KEYS.PAYMENT_SUCCEEDED,
          outcome.payload,
          traceId,
        );
      } else {
        await this.rmqService.publish(
          ROUTING_KEYS.PAYMENT_FAILED,
          outcome.payload,
          traceId,
        );
      }
    }

    return {
      received: true,
      deduplicated: false,
      eventId: stripeEvent.id,
      eventType: stripeEvent.type,
    };
  }

  async handleOrderRefundRequested(
    event: OrderRefundRequestedEvent,
    traceId?: string,
    eventId?: string,
  ): Promise<void> {
    const resolvedEventId =
      eventId || `${ROUTING_KEYS.ORDER_REFUND_REQUESTED}:${event.orderId}`;

    this.logger.log(
      `[Refund Saga] [traceId=${traceId || 'n/a'}] [eventId=${resolvedEventId}] Processing refund for order ${event.orderId} ($${event.amount})`,
    );

    // Domain-level idempotency check: never refund the same order twice
    const existingRefunded = await this.prisma.payment.findFirst({
      where: { orderId: event.orderId, status: 'REFUNDED' },
    });
    if (existingRefunded) {
      this.logger.warn(
        `[Idempotency] Order ${event.orderId} already refunded (${existingRefunded.refundTransactionId}) — skipping duplicate refund`,
      );
      return;
    }

    const successfulPayment = await this.prisma.payment.findFirst({
      where: { orderId: event.orderId, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
    });
    if (!successfulPayment) {
      this.logger.warn(
        `[Refund Saga] No SUCCESS payment found for order ${event.orderId} — ignoring refund request`,
      );
      return;
    }

    let refundTransactionId = `ref_${crypto.randomBytes(8).toString('hex')}`;

    if (
      this.stripe &&
      successfulPayment.provider === 'STRIPE' &&
      successfulPayment.stripePaymentIntentId
    ) {
      const stripeRefund = await this.stripe.refunds.create(
        {
          payment_intent: successfulPayment.stripePaymentIntentId,
          reason: 'requested_by_customer',
        },
        { idempotencyKey: `refund-${event.orderId}` },
      );
      refundTransactionId = stripeRefund.id;
    } else {
      // Simulate external PSP refund latency in mock mode
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const refundedAt = new Date();

    try {
      const updatedCount = await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            eventId: resolvedEventId,
            eventType: ROUTING_KEYS.ORDER_REFUND_REQUESTED,
          },
        });

        const res = await tx.payment.updateMany({
          where: { id: successfulPayment.id, status: 'SUCCESS' },
          data: {
            status: 'REFUNDED',
            refundTransactionId,
            refundedAt,
          },
        });
        return res.count;
      });

      if (updatedCount === 0) {
        this.logger.warn(
          `[Idempotency] Concurrent refund detected for order ${event.orderId} — skipping duplicate event publish`,
        );
        return;
      }
    } catch (err: any) {
      if (isPrismaUniqueConstraintError(err)) {
        this.logger.warn(
          `[Inbox] [traceId=${traceId || 'n/a'}] Duplicate refund request "${resolvedEventId}" already processed — skipping`,
        );
        return;
      }
      throw err;
    }

    const refundedEvent: PaymentRefundedEvent = {
      paymentId: successfulPayment.id,
      orderId: event.orderId,
      userId: event.userId,
      userEmail: event.userEmail,
      items: event.items,
      amount: Number(successfulPayment.amount),
      refundTransactionId,
      reason: event.reason,
      refundedAt: refundedAt.toISOString(),
    };

    await this.rmqService.publish(
      ROUTING_KEYS.PAYMENT_REFUNDED,
      refundedEvent,
      traceId,
    );
  }

  async getPaymentByOrderId(
    orderId: string,
    userId?: string,
    userRole?: UserRole,
  ): Promise<PaymentDto | null> {
    const payment = await this.prisma.payment.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) return null;

    // IDOR protection: only the owning customer or an ADMIN may inspect payment details
    if (userId && payment.userId !== userId && userRole !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Access denied: you can only view payment details for your own orders',
      );
    }

    return {
      id: payment.id,
      orderId: payment.orderId,
      userId: payment.userId,
      amount: Number(payment.amount),
      status: payment.status as PaymentStatus,
      provider: payment.provider,
      transactionId: payment.transactionId,
      stripeSessionId: payment.stripeSessionId,
      checkoutUrl: payment.checkoutUrl,
      refundTransactionId: payment.refundTransactionId,
      refundedAt: payment.refundedAt ? payment.refundedAt.toISOString() : null,
      createdAt: payment.createdAt.toISOString(),
    };
  }
}
