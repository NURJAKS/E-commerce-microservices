import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import {
  InvoiceGeneratedEvent,
  OrderCancelledEvent,
  OrderCreatedEvent,
  OrderRefundRequestedEvent,
  OrderStatus,
  PaymentRefundedEvent,
  PaymentSucceededEvent,
  ProductRestockedEvent,
  UserRegisteredEvent,
} from '@shop/contracts';
import { RabbitMQService, ROUTING_KEYS } from '@shop/rmq';
import { InvoicePdfService } from './invoice-pdf.service';
import { NotificationGateway } from './notification.gateway';

const RESTOCK_EMAIL_BATCH_SIZE = 10;

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly fromAddress: string;
  private readonly frontendUrl: string;

  constructor(
    private readonly rmqService: RabbitMQService,
    private readonly gateway: NotificationGateway,
    @Optional() private readonly invoicePdfService?: InvoicePdfService,
  ) {
    this.fromAddress =
      process.env.SMTP_FROM || 'no-reply@shop-monorepo.local';
    this.frontendUrl = (
      process.env.FRONTEND_PUBLIC_URL || 'http://localhost'
    ).replace(/\/$/, '');

    const smtpPort = Number(process.env.SMTP_PORT || 1025);
    const smtpSecure =
      process.env.SMTP_SECURE === 'true' || smtpPort === 465;
    const smtpUser = process.env.SMTP_USER?.trim();
    const smtpPass = process.env.SMTP_PASS?.trim();

    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'localhost',
      port: smtpPort,
      secure: smtpSecure,
      ...(smtpUser && smtpPass
        ? { auth: { user: smtpUser, pass: smtpPass } }
        : {}),
      tls: {
        rejectUnauthorized:
          process.env.NODE_ENV === 'production' &&
          process.env.SMTP_TLS_INSECURE !== 'true' &&
          Boolean(smtpUser),
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
      async (event, _rk, traceId) =>
        this.handlePaymentSucceeded(event, traceId),
    );

    await this.rmqService.subscribe<OrderCancelledEvent>(
      'notification.order_cancelled.queue',
      [ROUTING_KEYS.ORDER_CANCELLED],
      async (event) => this.handleOrderCancelled(event),
    );

    await this.rmqService.subscribe<OrderRefundRequestedEvent>(
      'notification.order_refund_requested.queue',
      [ROUTING_KEYS.ORDER_REFUND_REQUESTED],
      async (event) => this.handleOrderRefundRequested(event),
    );

    await this.rmqService.subscribe<PaymentRefundedEvent>(
      'notification.payment_refunded.queue',
      [ROUTING_KEYS.PAYMENT_REFUNDED],
      async (event) => this.handlePaymentRefunded(event),
    );

    await this.rmqService.subscribe<ProductRestockedEvent>(
      'notification.product_restocked.queue',
      [ROUTING_KEYS.PRODUCT_RESTOCKED],
      async (event) => this.handleProductRestocked(event),
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

  async handlePaymentSucceeded(
    event: PaymentSucceededEvent,
    traceId?: string,
  ): Promise<void> {
    this.gateway.emitOrderStatusUpdated({
      orderId: event.orderId,
      userId: event.userId,
      status: OrderStatus.PAID,
      message: `Order #${event.orderId.slice(0, 8)} paid ($${event.amount.toFixed(2)})!`,
      transactionId: event.transactionId,
      updatedAt: event.paidAt,
    });

    // Asynchronously generate PDF invoice, store in private MinIO bucket, attach to email, and notify order-service
    let pdfAttachment:
      | { filename: string; content: Buffer; contentType: string }
      | undefined;

    if (this.invoicePdfService) {
      try {
        const generated =
          await this.invoicePdfService.generateAndStoreInvoice(event);
        pdfAttachment = {
          filename: generated.fileName,
          content: generated.pdfBuffer,
          contentType: 'application/pdf',
        };

        const invoiceEvent: InvoiceGeneratedEvent = {
          orderId: event.orderId,
          userId: event.userId,
          invoiceKey: generated.key,
          generatedAt: new Date().toISOString(),
        };
        await this.rmqService.publish(
          ROUTING_KEYS.INVOICE_GENERATED,
          invoiceEvent,
          traceId,
        );
      } catch (err: any) {
        this.logger.warn(
          `[Invoice] Async PDF generation warning for order ${event.orderId}: ${err?.message || err}`,
        );
      }
    }

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
          <p style="color: #475569; font-size: 13px;">Your official PDF invoice is attached and can also be downloaded securely from your order page.</p>
        </div>
      `,
      pdfAttachment ? [pdfAttachment] : undefined,
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

  private async handleOrderRefundRequested(
    event: OrderRefundRequestedEvent,
  ): Promise<void> {
    this.gateway.emitOrderStatusUpdated({
      orderId: event.orderId,
      userId: event.userId,
      status: OrderStatus.REFUNDING,
      message: `Refund requested for Order #${event.orderId.slice(0, 8)} ($${event.amount.toFixed(2)}). Processing refund...`,
      updatedAt: event.requestedAt,
    });
  }

  private async handlePaymentRefunded(
    event: PaymentRefundedEvent,
  ): Promise<void> {
    this.gateway.emitOrderStatusUpdated({
      orderId: event.orderId,
      userId: event.userId,
      status: OrderStatus.REFUNDED,
      message: `Refund completed for Order #${event.orderId.slice(0, 8)} ($${event.amount.toFixed(2)}). Stock restored!`,
      transactionId: event.refundTransactionId,
      updatedAt: event.refundedAt,
    });

    const recipient =
      event.userEmail || `user-${event.userId.slice(0, 8)}@shop.local`;
    await this.sendHtmlEmail(
      recipient,
      `Refund Receipt for Order #${event.orderId.slice(0, 8)}`,
      `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #8b5cf6; border-radius: 12px;">
          <h2 style="color: #7c3aed;">Refund Processed</h2>
          <p style="color: #475569;">Your refund for order <strong>#${event.orderId.slice(0, 8)}</strong> has been completed and inventory has been restocked.</p>
          <p><strong>Refunded Amount:</strong> $${event.amount.toFixed(2)}</p>
          <p><strong>Refund Transaction ID:</strong> <code>${event.refundTransactionId}</code></p>
          <p><strong>Reason:</strong> ${event.reason}</p>
        </div>
      `,
    );
  }

  /**
   * Fans out Back-in-Stock alerts asynchronously in batches of 10 via Mailpit SMTP
   * and pushes real-time WebSocket toasts to signed-in subscribers.
   */
  async handleProductRestocked(event: ProductRestockedEvent): Promise<void> {
    const subscribers = event.subscribers || [];
    if (subscribers.length === 0) return;

    this.logger.log(
      `[Back-in-Stock] Fanning out restock alerts for "${event.productTitle}" to ${subscribers.length} subscriber(s) in batches of ${RESTOCK_EMAIL_BATCH_SIZE}`,
    );

    for (let i = 0; i < subscribers.length; i += RESTOCK_EMAIL_BATCH_SIZE) {
      const batch = subscribers.slice(i, i + RESTOCK_EMAIL_BATCH_SIZE);
      await Promise.allSettled(
        batch.map(async (sub) => {
          if (sub.userId) {
            this.gateway.emitProductRestocked(sub.userId, {
              productId: event.productId,
              productTitle: event.productTitle,
              price: event.price,
              stock: event.stock,
              message: `"${event.productTitle}" is back in stock (${event.stock} available at $${event.price.toFixed(2)})!`,
              restockedAt: event.restockedAt,
            });
          }

          await this.sendHtmlEmail(
            sub.email,
            `Back in Stock: ${event.productTitle}`,
            `
              <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #10b981; border-radius: 12px;">
                <h2 style="color: #059669;">Back in Stock!</h2>
                <p style="color: #475569;">Great news — <strong>${event.productTitle}</strong> is available again!</p>
                <p><strong>Price:</strong> $${event.price.toFixed(2)}</p>
                <p><strong>Available Stock:</strong> ${event.stock} unit(s)</p>
                <p style="margin-top: 16px;">
                  <a href="${this.frontendUrl}/products/${event.productId}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">
                    View Product
                  </a>
                </p>
              </div>
            `,
          );
        }),
      );
    }
  }

  private async sendHtmlEmail(
    to: string,
    subject: string,
    html: string,
    attachments?: Array<{
      filename: string;
      content: Buffer;
      contentType: string;
    }>,
  ): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.fromAddress,
        to,
        subject,
        html,
        ...(attachments ? { attachments } : {}),
      });
      this.logger.log(`Sent email "${subject}" to ${to} via Mailpit SMTP`);
    } catch (err: any) {
      this.logger.warn(
        `Failed to send email "${subject}" to ${to}: ${err?.message || err}`,
      );
    }
  }
}
