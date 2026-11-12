import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import {
  OrderCancelledEvent,
  OrderCreatedEvent,
  OrderStatus,
  PaymentSucceededEvent,
  UserRegisteredEvent,
} from '@shop/contracts';
import { RabbitMQService, ROUTING_KEYS } from '@shop/rmq';
import { NotificationGateway } from './notification.gateway';

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly fromAddress: string;

  constructor(
    private readonly rmqService: RabbitMQService,
    private readonly gateway: NotificationGateway,
  ) {
    this.fromAddress =
      process.env.SMTP_FROM || 'no-reply@shop-monorepo.local';
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'localhost',
      port: Number(process.env.SMTP_PORT || 1025),
      secure: false,
      tls: {
        rejectUnauthorized: false,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.rmqService.subscribe<UserRegisteredEvent>(
      'notification.user_registered.queue',
      [ROUTING_KEYS.USER_REGISTERED],
      async (event) => this.handleUserRegistered(event),
    );

    await this.rmqService.subscribe<OrderCreatedEvent>(
      'notification.order_created.queue',
      [ROUTING_KEYS.ORDER_CREATED],
      async (event) => this.handleOrderCreated(event),
    );

    await this.rmqService.subscribe<PaymentSucceededEvent>(
      'notification.payment_succeeded.queue',
      [ROUTING_KEYS.PAYMENT_SUCCEEDED],
      async (event) => this.handlePaymentSucceeded(event),
    );

    await this.rmqService.subscribe<OrderCancelledEvent>(
      'notification.order_cancelled.queue',
      [ROUTING_KEYS.ORDER_CANCELLED],
      async (event) => this.handleOrderCancelled(event),
    );
  }

  private async handleUserRegistered(
    event: UserRegisteredEvent,
  ): Promise<void> {
    await this.sendHtmlEmail(
      event.email,
      'Welcome to Shop Monorepo!',
      `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px;">
          <h2 style="color: #0f172a;">Welcome aboard, ${event.email}!</h2>
          <p style="color: #475569;">Your account has been created with role <strong>${event.role}</strong>.</p>
          <p style="color: #64748b; font-size: 13px;">Registered at: ${event.registeredAt}</p>
        </div>
      `,
    );
  }

  private async handleOrderCreated(event: OrderCreatedEvent): Promise<void> {
    this.gateway.emitOrderStatusUpdated({
      orderId: event.orderId,
      userId: event.userId,
      status: OrderStatus.PENDING,
      message: `Order #${event.orderId.slice(0, 8)} created ($${event.totalAmount.toFixed(2)}). Reserving stock...`,
      updatedAt: new Date().toISOString(),
    });

    const recipient = event.userEmail || `user-${event.userId.slice(0, 8)}@shop.local`;
    await this.sendHtmlEmail(
      recipient,
      `Order #${event.orderId.slice(0, 8)} Received`,
      `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px;">
          <h2 style="color: #0f172a;">Order Confirmation #${event.orderId.slice(0, 8)}</h2>
          <p style="color: #475569;">We have received your order and are reserving stock and processing payment.</p>
          <p><strong>Total Amount:</strong> $${event.totalAmount.toFixed(2)}</p>
        </div>
      `,
    );
  }

  private async handlePaymentSucceeded(
    event: PaymentSucceededEvent,
  ): Promise<void> {
    this.gateway.emitOrderStatusUpdated({
      orderId: event.orderId,
      userId: event.userId,
      status: OrderStatus.PAID,
      message: `Order #${event.orderId.slice(0, 8)} paid ($${event.amount.toFixed(2)})!`,
      transactionId: event.transactionId,
      updatedAt: event.paidAt,
    });

    const recipient = event.userEmail || `user-${event.userId.slice(0, 8)}@shop.local`;
    await this.sendHtmlEmail(
      recipient,
      `Payment Succeeded for Order #${event.orderId.slice(0, 8)}`,
      `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #10b981; border-radius: 12px;">
          <h2 style="color: #059669;">Payment Confirmed!</h2>
          <p style="color: #475569;">Your payment for order <strong>#${event.orderId.slice(0, 8)}</strong> succeeded.</p>
          <p><strong>Amount Paid:</strong> $${event.amount.toFixed(2)}</p>
          <p><strong>Transaction ID:</strong> <code>${event.transactionId}</code></p>
        </div>
      `,
    );
  }

  private async handleOrderCancelled(
    event: OrderCancelledEvent,
  ): Promise<void> {
    const isPaymentFailure = event.reason
      .toLowerCase()
      .includes('payment failed');

    this.gateway.emitOrderStatusUpdated({
      orderId: event.orderId,
      userId: event.userId,
      status: isPaymentFailure ? OrderStatus.FAILED : OrderStatus.CANCELLED,
      message: `Order #${event.orderId.slice(0, 8)} ${isPaymentFailure ? 'failed' : 'cancelled'}: ${event.reason}`,
      updatedAt: event.cancelledAt,
    });

    const recipient = event.userEmail || `user-${event.userId.slice(0, 8)}@shop.local`;
    await this.sendHtmlEmail(
      recipient,
      `Order #${event.orderId.slice(0, 8)} Cancelled`,
      `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #ef4444; border-radius: 12px;">
          <h2 style="color: #dc2626;">Order Cancelled</h2>
          <p style="color: #475569;">Your order <strong>#${event.orderId.slice(0, 8)}</strong> could not be completed.</p>
          <p><strong>Reason:</strong> ${event.reason}</p>
        </div>
      `,
    );
  }

  private async sendHtmlEmail(
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.fromAddress,
        to,
        subject,
        html,
      });
      this.logger.log(`Sent email "${subject}" to ${to} via Mailpit SMTP`);
    } catch (err: any) {
      this.logger.warn(
        `Failed to send email "${subject}" to ${to}: ${err?.message || err}`,
      );
    }
  }
}
