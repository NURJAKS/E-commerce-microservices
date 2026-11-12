import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  PaymentDto,
  PaymentFailedEvent,
  PaymentStatus,
  PaymentSucceededEvent,
  StockReservedEvent,
} from '@shop/contracts';
import { RabbitMQService, ROUTING_KEYS } from '@shop/rmq';
import { PrismaService } from './prisma.service';

@Injectable()
export class PaymentService implements OnModuleInit {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rmqService: RabbitMQService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.rmqService.subscribe<StockReservedEvent>(
      'payment.stock_reserved.queue',
      [ROUTING_KEYS.STOCK_RESERVED],
      async (event, _rk, traceId) => this.handleStockReserved(event, traceId),
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

    const pendingPayment = await this.prisma.payment.create({
      data: {
        orderId: event.orderId,
        userId: event.userId,
        amount: event.totalAmount,
        status: 'PENDING',
      },
    });

    // Deterministic mock PSP with FAIL_PAYMENT trigger to exercise Saga compensation without external gateway keys
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

  async getPaymentByOrderId(orderId: string): Promise<PaymentDto | null> {
    const payment = await this.prisma.payment.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) return null;

    return {
      id: payment.id,
      orderId: payment.orderId,
      userId: payment.userId,
      amount: Number(payment.amount),
      status: payment.status as PaymentStatus,
      transactionId: payment.transactionId,
      createdAt: payment.createdAt.toISOString(),
    };
  }
}
