import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Interval } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import {
  CATALOG_PATTERNS,
  InvoiceDownloadResponse,
  InvoiceGeneratedEvent,
  OrderCancelledEvent,
  OrderCreatedEvent,
  OrderDto,
  OrderRefundRequestedEvent,
  OrderStatus,
  PaymentFailedEvent,
  PaymentRefundedEvent,
  PaymentSucceededEvent,
  SERVICES,
  StockCheckResponse,
  StockFailedEvent,
  UserRole,
  ValidateDiscountResult,
} from '@shop/contracts';
import { isPrismaUniqueConstraintError } from '@shop/common';
import { RabbitMQService, ROUTING_KEYS } from '@shop/rmq';
import { CartService } from './cart.service';
import { InvoiceStorageService } from './invoice-storage.service';
import { PrismaService } from './prisma.service';

export interface DiscountCalculationInput {
  subtotal: number;
  percentage?: number;
  fixedAmount?: number;
  minOrderAmount?: number;
}

export interface DiscountCalculationOutput {
  subtotal: number;
  discountAmount: number;
  finalTotal: number;
}

@Injectable()
export class OrderService implements OnModuleInit {
  private readonly logger = new Logger(OrderService.name);
  private isProcessingOutbox = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cartService: CartService,
    private readonly rmqService: RabbitMQService,
    @Inject(SERVICES.CATALOG) private readonly catalogClient: ClientProxy,
    @Optional() private readonly invoiceStorage?: InvoiceStorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.rmqService.subscribe<PaymentSucceededEvent>(
      'order.payment_succeeded.queue',
      [ROUTING_KEYS.PAYMENT_SUCCEEDED],
      async (event, _rk, traceId, eventId) =>
        this.handlePaymentSucceeded(event, traceId, eventId),
    );

    await this.rmqService.subscribe<PaymentFailedEvent>(
      'order.payment_failed.queue',
      [ROUTING_KEYS.PAYMENT_FAILED],
      async (event, _rk, traceId, eventId) =>
        this.handlePaymentFailed(event, traceId, eventId),
    );

    await this.rmqService.subscribe<StockFailedEvent>(
      'order.stock_failed.queue',
      [ROUTING_KEYS.STOCK_FAILED],
      async (event, _rk, traceId, eventId) =>
        this.handleStockFailed(event, traceId, eventId),
    );

    await this.rmqService.subscribe<PaymentRefundedEvent>(
      'order.payment_refunded.queue',
      [ROUTING_KEYS.PAYMENT_REFUNDED],
      async (event, _rk, traceId, eventId) =>
        this.handlePaymentRefunded(event, traceId, eventId),
    );

    await this.rmqService.subscribe<InvoiceGeneratedEvent>(
      'order.invoice_generated.queue',
      [ROUTING_KEYS.INVOICE_GENERATED],
      async (event, _rk, traceId, eventId) =>
        this.handleInvoiceGenerated(event, traceId, eventId),
    );
  }

  calculatePromoDiscount(
    input: DiscountCalculationInput,
  ): DiscountCalculationOutput {
    const subtotal = Number(input.subtotal.toFixed(2));
    if (subtotal <= 0) {
      throw new BadRequestException('Order subtotal must be greater than zero');
    }

    const minOrder = input.minOrderAmount ?? 0;
    if (minOrder > 0 && subtotal < minOrder) {
      throw new BadRequestException(
        `Order subtotal ($${subtotal.toFixed(2)}) does not meet minimum requirement ($${minOrder.toFixed(2)}) for this promo code`,
      );
    }

    const percentage = Math.max(0, Math.min(100, input.percentage ?? 0));
    const fixedAmount = Math.max(0, input.fixedAmount ?? 0);

    const percentDiscount = (subtotal * percentage) / 100;
    const rawDiscount = percentDiscount + fixedAmount;
    const discountAmount = Number(Math.min(subtotal, rawDiscount).toFixed(2));
    const finalTotal = Number(Math.max(0, subtotal - discountAmount).toFixed(2));

    return {
      subtotal,
      discountAmount,
      finalTotal,
    };
  }

  async checkout(
    userId: string,
    userEmail?: string,
    discountCode?: string,
    traceId?: string,
  ): Promise<OrderDto> {
    const cart = await this.cartService.getCart(userId);
    if (!cart.items || cart.items.length === 0) {
      throw new BadRequestException('Cannot checkout with an empty cart');
    }

    const stockCheck = await firstValueFrom(
      this.catalogClient.send<StockCheckResponse>(CATALOG_PATTERNS.CHECK_STOCK, {
        items: cart.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
        })),
      }),
    );

    if (!stockCheck.available) {
      throw new BadRequestException(
        `Insufficient stock for item: ${stockCheck.unavailableItem || 'unknown'}`,
      );
    }

    // Security: always price orders from authoritative catalog_db quotes, never trusting client-supplied cart prices
    const quotedMap = new Map(
      (stockCheck.quotedItems || []).map((q) => [q.productId, q]),
    );
    const authoritativeItems = cart.items.map((item) => {
      const quote = quotedMap.get(item.productId);
      if (!quote || !Number.isFinite(quote.unitPrice) || quote.unitPrice <= 0) {
        throw new BadRequestException(
          `Unable to verify authoritative catalog price for product "${item.productId}"`,
        );
      }
      return {
        productId: item.productId,
        productTitle: quote.productTitle,
        quantity: item.quantity,
        unitPrice: Number(quote.unitPrice),
      };
    });

    const authoritativeSubtotal = Number(
      authoritativeItems
        .reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
        .toFixed(2),
    );

    let appliedCode: string | null = null;
    let percentage = 0;
    let fixedAmount = 0;

    if (discountCode && discountCode.trim().length > 0) {
      const validation = await firstValueFrom(
        this.catalogClient.send<ValidateDiscountResult>(
          CATALOG_PATTERNS.VALIDATE_DISCOUNT,
          { code: discountCode.trim(), userId },
        ),
      );

      if (!validation.valid) {
        throw new BadRequestException(
          validation.reason || `Invalid promo code "${discountCode}"`,
        );
      }

      appliedCode = validation.code;
      percentage = validation.percentage;
      fixedAmount = validation.fixedAmount;
    }

    const { finalTotal } = this.calculatePromoDiscount({
      subtotal: authoritativeSubtotal,
      percentage,
      fixedAmount,
    });

    // Transactional Outbox: persist Order and Outbox event in one ACID transaction to eliminate Dual-Write loss if RabbitMQ drops
    const order = await this.prisma.$transaction(async (tx) => {
      const createdOrder = await tx.order.create({
        data: {
          userId,
          status: 'PENDING',
          totalAmount: finalTotal,
          discountCode: appliedCode,
          items: {
            create: authoritativeItems.map((item) => ({
              productId: item.productId,
              productTitle: item.productTitle,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
            })),
          },
        },
        include: { items: true },
      });

      const eventPayload: OrderCreatedEvent = {
        orderId: createdOrder.id,
        userId: createdOrder.userId,
        userEmail,
        items: createdOrder.items.map((i) => ({
          productId: i.productId,
          productTitle: i.productTitle,
          quantity: i.quantity,
          unitPrice: Number(i.unitPrice),
        })),
        totalAmount: Number(createdOrder.totalAmount),
        discountCode: createdOrder.discountCode,
        createdAt: createdOrder.createdAt.toISOString(),
      };

      await tx.outbox.create({
        data: {
          aggregateId: createdOrder.id,
          eventType: ROUTING_KEYS.ORDER_CREATED,
          payload: eventPayload as any,
          traceId: traceId || null,
          published: false,
        },
      });

      return createdOrder;
    });

    await this.cartService.clearCart(userId);

    // Eager relay avoids the 1.5s polling delay on happy path; @Interval remains the At-Least-Once fallback
    await this.processOutboxBatch();

    return this.toOrderDto(order);
  }

  /**
   * Relays unpublished Outbox rows to RabbitMQ (At-Least-Once Delivery).
   * Uses PostgreSQL `FOR UPDATE SKIP LOCKED` inside a transaction so multiple
   * horizontal `order-service` replicas never claim or relay the same Outbox row concurrently.
   */
  @Interval(1500)
  async processOutboxBatch(): Promise<number> {
    if (this.isProcessingOutbox) return 0;
    this.isProcessingOutbox = true;

    try {
      const relayBatch = async (tx: any): Promise<number> => {
        const pendingEvents: Array<{
          id: string;
          eventType: string;
          payload: any;
          traceId: string | null;
        }> =
          typeof tx.$queryRaw === 'function'
            ? await tx.$queryRaw`
                SELECT "id", "eventType", "payload", "traceId"
                FROM "Outbox"
                WHERE "published" = false
                ORDER BY "createdAt" ASC
                LIMIT 25
                FOR UPDATE SKIP LOCKED
              `
            : await tx.outbox.findMany({
                where: { published: false },
                orderBy: { createdAt: 'asc' },
                take: 25,
              });

        let publishedCount = 0;
        for (const record of pendingEvents) {
          const ok = await this.rmqService.publish(
            record.eventType,
            record.payload,
            record.traceId || undefined,
            record.id,
          );

          if (ok) {
            await tx.outbox.update({
              where: { id: record.id },
              data: {
                published: true,
                publishedAt: new Date(),
                attempts: { increment: 1 },
              },
            });
            publishedCount++;
          } else {
            await tx.outbox.update({
              where: { id: record.id },
              data: {
                attempts: { increment: 1 },
              },
            });
          }
        }
        return publishedCount;
      };

      return await this.prisma.$transaction(async (tx) => relayBatch(tx));
    } catch (err: any) {
      this.logger.warn(
        `Outbox polling warning: ${err?.message || err}`,
      );
      return 0;
    } finally {
      this.isProcessingOutbox = false;
    }
  }

  async getUserOrders(userId: string): Promise<OrderDto[]> {
    const orders = await this.prisma.order.findMany({
      where: { userId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    return orders.map((o) => this.toOrderDto(o));
  }

  async getOrderById(orderId: string, userId?: string): Promise<OrderDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order || (userId && order.userId !== userId)) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }
    return this.toOrderDto(order);
  }

  /**
   * Initiates the Refund Choreography Saga using the Transactional Outbox Pattern:
   * atomically transitions PAID -> REFUNDING and persists `order.refund_requested` in Outbox.
   */
  async requestRefund(
    orderId: string,
    userId: string,
    userRole?: UserRole,
    userEmail?: string,
    reason?: string,
    traceId?: string,
  ): Promise<OrderDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (order.userId !== userId && userRole !== UserRole.ADMIN) {
      throw new ForbiddenException('You are not allowed to refund this order');
    }

    if (order.status === 'REFUNDING' || order.status === 'REFUNDED') {
      throw new ConflictException(
        `Order ${orderId} is already in status ${order.status}`,
      );
    }

    if (order.status !== 'PAID') {
      throw new BadRequestException(
        `Only PAID orders can be refunded (current status: ${order.status})`,
      );
    }

    const resolvedReason = (reason || '').trim() || 'Customer requested refund';
    const requestedAt = new Date().toISOString();

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: { id: orderId, status: 'PAID' },
        data: { status: 'REFUNDING' },
      });

      if (updated.count === 0) {
        throw new ConflictException(
          `Order ${orderId} refund is already in progress`,
        );
      }

      const refundEvent: OrderRefundRequestedEvent = {
        orderId: order.id,
        userId: order.userId,
        userEmail,
        items: order.items.map((i) => ({
          productId: i.productId,
          productTitle: i.productTitle,
          quantity: i.quantity,
          unitPrice: Number(i.unitPrice),
        })),
        amount: Number(order.totalAmount),
        reason: resolvedReason,
        requestedAt,
      };

      await tx.outbox.create({
        data: {
          aggregateId: order.id,
          eventType: ROUTING_KEYS.ORDER_REFUND_REQUESTED,
          payload: refundEvent as any,
          traceId: traceId || null,
          published: false,
        },
      });
    });

    // Eagerly relay the refund request to RabbitMQ without waiting for the 1.5s interval
    await this.processOutboxBatch();

    return this.toOrderDto({ ...order, status: 'REFUNDING' });
  }

  /**
   * IDOR-protected PDF Invoice download:
   * Verifies that the authenticated user owns the order (or is ADMIN), ensures the order is paid,
   * and returns a 60-second Presigned GET URL to the private MinIO invoices bucket.
   */
  async getInvoiceDownloadUrl(
    orderId: string,
    userId: string,
    userRole?: UserRole,
  ): Promise<InvoiceDownloadResponse> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (order.userId !== userId && userRole !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Access denied: you can only download invoices for your own orders',
      );
    }

    if (
      order.status !== 'PAID' &&
      order.status !== 'REFUNDING' &&
      order.status !== 'REFUNDED'
    ) {
      throw new BadRequestException(
        `PDF invoice is only available for paid orders (current status: ${order.status})`,
      );
    }

    if (!this.invoiceStorage) {
      throw new BadRequestException('Invoice storage service is unavailable');
    }

    let invoiceKey = order.invoiceKey;
    if (!invoiceKey) {
      invoiceKey = await this.invoiceStorage.ensureFallbackInvoice(order);
      await this.prisma.order.updateMany({
        where: { id: order.id },
        data: { invoiceKey },
      });
    }

    return this.invoiceStorage.createPresignedDownloadUrl(invoiceKey, order.id);
  }

  async handleInvoiceGenerated(
    event: InvoiceGeneratedEvent,
    traceId?: string,
    eventId?: string,
  ): Promise<void> {
    const resolvedEventId =
      eventId || `${ROUTING_KEYS.INVOICE_GENERATED}:${event.orderId}`;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            eventId: resolvedEventId,
            eventType: ROUTING_KEYS.INVOICE_GENERATED,
          },
        });

        await tx.order.updateMany({
          where: { id: event.orderId },
          data: { invoiceKey: event.invoiceKey },
        });
      });
    } catch (err: any) {
      if (isPrismaUniqueConstraintError(err)) {
        this.logger.warn(
          `[Inbox] [traceId=${traceId || 'n/a'}] Duplicate invoice event "${resolvedEventId}" already processed — skipping`,
        );
        return;
      }
      throw err;
    }
  }

  async handlePaymentRefunded(
    event: PaymentRefundedEvent,
    traceId?: string,
    eventId?: string,
  ): Promise<void> {
    const resolvedEventId =
      eventId ||
      `${ROUTING_KEYS.PAYMENT_REFUNDED}:${event.refundTransactionId || event.orderId}`;

    this.logger.log(
      `[Refund Saga] [traceId=${traceId || 'n/a'}] [eventId=${resolvedEventId}] Marking order ${event.orderId} as REFUNDED (refundTx: ${event.refundTransactionId})`,
    );

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            eventId: resolvedEventId,
            eventType: ROUTING_KEYS.PAYMENT_REFUNDED,
          },
        });

        await tx.order.updateMany({
          where: { id: event.orderId },
          data: { status: 'REFUNDED' },
        });
      });
    } catch (err: any) {
      if (isPrismaUniqueConstraintError(err)) {
        this.logger.warn(
          `[Inbox] [traceId=${traceId || 'n/a'}] Duplicate refund event "${resolvedEventId}" already processed — skipping order ${event.orderId} REFUNDED update`,
        );
        return;
      }
      throw err;
    }
  }

  async handlePaymentSucceeded(
    event: PaymentSucceededEvent,
    traceId?: string,
    eventId?: string,
  ): Promise<void> {
    const resolvedEventId =
      eventId ||
      `${ROUTING_KEYS.PAYMENT_SUCCEEDED}:${event.paymentId || event.orderId}`;

    this.logger.log(
      `[Saga] [traceId=${traceId || 'n/a'}] [eventId=${resolvedEventId}] Marking order ${event.orderId} as PAID (tx: ${event.transactionId})`,
    );

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            eventId: resolvedEventId,
            eventType: ROUTING_KEYS.PAYMENT_SUCCEEDED,
          },
        });

        await tx.order.updateMany({
          where: { id: event.orderId },
          data: { status: 'PAID' },
        });
      });
    } catch (err: any) {
      if (isPrismaUniqueConstraintError(err)) {
        this.logger.warn(
          `[Inbox] [traceId=${traceId || 'n/a'}] Duplicate event "${resolvedEventId}" already processed — skipping order ${event.orderId} PAID update`,
        );
        return;
      }
      throw err;
    }
  }

  async handlePaymentFailed(
    event: PaymentFailedEvent,
    traceId?: string,
    eventId?: string,
  ): Promise<void> {
    const resolvedEventId =
      eventId ||
      `${ROUTING_KEYS.PAYMENT_FAILED}:${event.paymentId || event.orderId}`;

    this.logger.warn(
      `[Saga] [traceId=${traceId || 'n/a'}] [eventId=${resolvedEventId}] Marking order ${event.orderId} as FAILED (reason: ${event.reason})`,
    );

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            eventId: resolvedEventId,
            eventType: ROUTING_KEYS.PAYMENT_FAILED,
          },
        });

        await tx.order.updateMany({
          where: { id: event.orderId },
          data: { status: 'FAILED' },
        });
      });
    } catch (err: any) {
      if (isPrismaUniqueConstraintError(err)) {
        this.logger.warn(
          `[Inbox] [traceId=${traceId || 'n/a'}] Duplicate event "${resolvedEventId}" already processed — skipping duplicate FAILED transition`,
        );
        return;
      }
      throw err;
    }

    const cancelledEvent: OrderCancelledEvent = {
      orderId: event.orderId,
      userId: event.userId,
      userEmail: event.userEmail,
      reason: `Payment failed: ${event.reason}`,
      cancelledAt: new Date().toISOString(),
    };
    await this.rmqService.publish(
      ROUTING_KEYS.ORDER_CANCELLED,
      cancelledEvent,
      traceId,
    );
  }

  async handleStockFailed(
    event: StockFailedEvent,
    traceId?: string,
    eventId?: string,
  ): Promise<void> {
    const resolvedEventId =
      eventId || `${ROUTING_KEYS.STOCK_FAILED}:${event.orderId}`;

    this.logger.warn(
      `[Saga] [traceId=${traceId || 'n/a'}] [eventId=${resolvedEventId}] Marking order ${event.orderId} as CANCELLED (reason: ${event.reason})`,
    );

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            eventId: resolvedEventId,
            eventType: ROUTING_KEYS.STOCK_FAILED,
          },
        });

        await tx.order.updateMany({
          where: { id: event.orderId },
          data: { status: 'CANCELLED' },
        });
      });
    } catch (err: any) {
      if (isPrismaUniqueConstraintError(err)) {
        this.logger.warn(
          `[Inbox] [traceId=${traceId || 'n/a'}] Duplicate event "${resolvedEventId}" already processed — skipping duplicate CANCELLED transition`,
        );
        return;
      }
      throw err;
    }

    const cancelledEvent: OrderCancelledEvent = {
      orderId: event.orderId,
      userId: event.userId,
      userEmail: event.userEmail,
      reason: event.reason,
      cancelledAt: new Date().toISOString(),
    };
    await this.rmqService.publish(
      ROUTING_KEYS.ORDER_CANCELLED,
      cancelledEvent,
      traceId,
    );
  }

  private toOrderDto(order: any): OrderDto {
    return {
      id: order.id,
      userId: order.userId,
      status: order.status as OrderStatus,
      totalAmount: Number(order.totalAmount),
      discountCode: order.discountCode,
      invoiceKey: order.invoiceKey ?? null,
      createdAt: order.createdAt.toISOString(),
      items: (order.items || []).map((i: any) => ({
        id: i.id,
        orderId: i.orderId,
        productId: i.productId,
        productTitle: i.productTitle,
        quantity: i.quantity,
        unitPrice: Number(i.unitPrice),
      })),
    };
  }
}
