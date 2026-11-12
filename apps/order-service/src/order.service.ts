import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Interval } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import {
  CATALOG_PATTERNS,
  OrderCancelledEvent,
  OrderCreatedEvent,
  OrderDto,
  OrderStatus,
  PaymentFailedEvent,
  PaymentSucceededEvent,
  SERVICES,
  StockFailedEvent,
  ValidateDiscountResult,
} from '@shop/contracts';
import { RabbitMQService, ROUTING_KEYS } from '@shop/rmq';
import { CartService } from './cart.service';
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
  ) {}

  async onModuleInit(): Promise<void> {
    await this.rmqService.subscribe<PaymentSucceededEvent>(
      'order.payment_succeeded.queue',
      [ROUTING_KEYS.PAYMENT_SUCCEEDED],
      async (event, _rk, traceId) =>
        this.handlePaymentSucceeded(event, traceId),
    );

    await this.rmqService.subscribe<PaymentFailedEvent>(
      'order.payment_failed.queue',
      [ROUTING_KEYS.PAYMENT_FAILED],
      async (event, _rk, traceId) => this.handlePaymentFailed(event, traceId),
    );

    await this.rmqService.subscribe<StockFailedEvent>(
      'order.stock_failed.queue',
      [ROUTING_KEYS.STOCK_FAILED],
      async (event, _rk, traceId) => this.handleStockFailed(event, traceId),
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
      this.catalogClient.send<{
        available: boolean;
        unavailableItem?: string;
      }>(CATALOG_PATTERNS.CHECK_STOCK, {
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

    let appliedCode: string | null = null;
    let percentage = 0;
    let fixedAmount = 0;

    if (discountCode && discountCode.trim().length > 0) {
      const validation = await firstValueFrom(
        this.catalogClient.send<ValidateDiscountResult>(
          CATALOG_PATTERNS.VALIDATE_DISCOUNT,
          { code: discountCode.trim() },
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
      subtotal: cart.subtotal,
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
            create: cart.items.map((item) => ({
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
   * For horizontal multi-replica deployments, use FOR UPDATE SKIP LOCKED or WAL CDC (Debezium).
   */
  @Interval(1500)
  async processOutboxBatch(): Promise<number> {
    if (this.isProcessingOutbox) return 0;
    this.isProcessingOutbox = true;

    try {
      const pendingEvents = await this.prisma.outbox.findMany({
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
        );

        if (ok) {
          await this.prisma.outbox.update({
            where: { id: record.id },
            data: {
              published: true,
              publishedAt: new Date(),
              attempts: { increment: 1 },
            },
          });
          publishedCount++;
        } else {
          await this.prisma.outbox.update({
            where: { id: record.id },
            data: {
              attempts: { increment: 1 },
            },
          });
        }
      }
      return publishedCount;
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

  async handlePaymentSucceeded(
    event: PaymentSucceededEvent,
    traceId?: string,
  ): Promise<void> {
    this.logger.log(
      `[Saga] [traceId=${traceId || 'n/a'}] Marking order ${event.orderId} as PAID (tx: ${event.transactionId})`,
    );

    await this.prisma.order.updateMany({
      where: { id: event.orderId },
      data: { status: 'PAID' },
    });
  }

  async handlePaymentFailed(
    event: PaymentFailedEvent,
    traceId?: string,
  ): Promise<void> {
    this.logger.warn(
      `[Saga] [traceId=${traceId || 'n/a'}] Marking order ${event.orderId} as FAILED (reason: ${event.reason})`,
    );

    await this.prisma.order.updateMany({
      where: { id: event.orderId },
      data: { status: 'FAILED' },
    });

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
  ): Promise<void> {
    this.logger.warn(
      `[Saga] [traceId=${traceId || 'n/a'}] Marking order ${event.orderId} as CANCELLED (reason: ${event.reason})`,
    );

    await this.prisma.order.updateMany({
      where: { id: event.orderId },
      data: { status: 'CANCELLED' },
    });

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
