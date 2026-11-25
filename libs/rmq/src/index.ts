import {
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as amqplib from 'amqplib';
import * as crypto from 'crypto';

export const SHOP_EVENTS_EXCHANGE = 'shop.events';
export const SHOP_DLX_EXCHANGE = 'shop.dlx';
export const SHOP_DLQ_QUEUE = 'shop.dlq';
export const MAX_RMQ_RETRY_ATTEMPTS = 3;
export const RMQ_MODULE_OPTIONS = 'RMQ_MODULE_OPTIONS';

export const ROUTING_KEYS = {
  USER_REGISTERED: 'user.registered',
  ORDER_CREATED: 'order.created',
  STOCK_RESERVED: 'catalog.stock.reserved',
  STOCK_FAILED: 'catalog.stock.failed',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_REFUND_REQUESTED: 'order.refund_requested',
  PAYMENT_REFUNDED: 'payment.refunded',
  PRODUCT_RESTOCKED: 'catalog.product.restocked',
  INVOICE_GENERATED: 'order.invoice.generated',
} as const;

export interface RmqModuleOptions {
  url?: string;
  exchange?: string;
  serviceName: string;
}

interface PendingSubscription {
  queueName: string;
  routingKeys: string[];
  handler: (
    payload: any,
    routingKey: string,
    traceId?: string,
    eventId?: string,
  ) => Promise<void>;
}

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private readonly exchange: string;
  private readonly url: string;
  private readonly pendingSubscriptions: PendingSubscription[] = [];
  private readonly consumerTags: string[] = [];
  private isConnecting = false;
  private isConnected = false;
  private isShuttingDown = false;
  private inFlightCount = 0;

  constructor(
    @Inject(RMQ_MODULE_OPTIONS) private readonly options: RmqModuleOptions,
  ) {
    this.url =
      options.url ||
      process.env.RABBITMQ_URL ||
      'amqp://guest:guest@localhost:5672';
    this.exchange = options.exchange || SHOP_EVENTS_EXCHANGE;
  }

  isHealthy(): boolean {
    return Boolean(
      this.connection && this.channel && this.isConnected && !this.isShuttingDown,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.ensureConnected();
  }

  async ensureConnected(): Promise<void> {
    if (this.channel || this.isConnecting || this.isShuttingDown) {
      return;
    }
    this.isConnecting = true;
    const maxAttempts = 15;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.connection = await amqplib.connect(this.url);
        this.connection.on('error', (err) => {
          this.isConnected = false;
          this.logger.warn(
            `[${this.options.serviceName}] RabbitMQ connection error: ${err?.message || err}`,
          );
        });
        this.connection.on('close', () => {
          this.isConnected = false;
          this.channel = null;
          this.connection = null;
        });

        this.channel = await this.connection.createChannel();
        this.channel.on('close', () => {
          this.isConnected = false;
          this.channel = null;
        });
        this.isConnected = true;

        // 1. Assert primary Topic Exchange
        await this.channel.assertExchange(this.exchange, 'topic', {
          durable: true,
        });

        // 2. Assert Dead Letter Exchange (DLX) and Dead Letter Queue (DLQ)
        await this.channel.assertExchange(SHOP_DLX_EXCHANGE, 'topic', {
          durable: true,
        });
        await this.channel.assertQueue(SHOP_DLQ_QUEUE, { durable: true });
        await this.channel.bindQueue(SHOP_DLQ_QUEUE, SHOP_DLX_EXCHANGE, '#');

        this.logger.log(
          `[${this.options.serviceName}] Connected to RabbitMQ Topic Exchange "${this.exchange}" (DLX: "${SHOP_DLX_EXCHANGE}" -> DLQ: "${SHOP_DLQ_QUEUE}")`,
        );

        for (const sub of this.pendingSubscriptions) {
          await this.bindSubscription(
            sub.queueName,
            sub.routingKeys,
            sub.handler,
          );
        }
        this.isConnecting = false;
        return;
      } catch (err: any) {
        this.isConnected = false;
        this.logger.warn(
          `[${this.options.serviceName}] RabbitMQ connection attempt ${attempt}/${maxAttempts} failed: ${err?.message || err}`,
        );
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    }
    this.isConnecting = false;
  }

  async publish<T>(
    routingKey: string,
    payload: T,
    traceId?: string,
    eventId?: string,
  ): Promise<boolean> {
    if (!this.channel) {
      await this.ensureConnected();
    }
    if (!this.channel) {
      this.logger.error(
        `Cannot publish event "${routingKey}" — RabbitMQ channel unavailable`,
      );
      return false;
    }

    const startTimeMs = Date.now();
    const resolvedTraceId =
      traceId ||
      (payload as any)?.traceId ||
      crypto.randomBytes(16).toString('hex');
    const resolvedEventId =
      eventId || (payload as any)?.eventId || crypto.randomUUID();

    const buffer = Buffer.from(JSON.stringify(payload));
    const published = this.channel.publish(this.exchange, routingKey, buffer, {
      persistent: true,
      contentType: 'application/json',
      messageId: resolvedEventId,
      timestamp: startTimeMs,
      headers: {
        'x-trace-id': resolvedTraceId,
        'x-event-id': resolvedEventId,
        'x-retry-count': 0,
      },
    });

    this.logger.log(
      `[${this.options.serviceName}] [traceId=${resolvedTraceId}] [eventId=${resolvedEventId}] Published event "${routingKey}" to "${this.exchange}"`,
    );

    return published;
  }

  async subscribe<T>(
    queueName: string,
    routingKeys: string[],
    handler: (
      payload: T,
      routingKey: string,
      traceId?: string,
      eventId?: string,
    ) => Promise<void>,
  ): Promise<void> {
    if (!this.channel) {
      this.pendingSubscriptions.push({ queueName, routingKeys, handler });
      return;
    }
    await this.bindSubscription(queueName, routingKeys, handler);
  }

  private async bindSubscription<T>(
    queueName: string,
    routingKeys: string[],
    handler: (
      payload: T,
      routingKey: string,
      traceId?: string,
      eventId?: string,
    ) => Promise<void>,
  ): Promise<void> {
    if (!this.channel) return;

    // Configure queue with Dead Letter Exchange (DLX) for poison message isolation
    await this.channel.assertQueue(queueName, {
      durable: true,
      deadLetterExchange: SHOP_DLX_EXCHANGE,
    });
    for (const key of routingKeys) {
      await this.channel.bindQueue(queueName, this.exchange, key);
    }

    const { consumerTag } = await this.channel.consume(
      queueName,
      async (msg) => {
        if (!msg || !this.channel) return;
        this.inFlightCount++;
        const routingKey = msg.fields.routingKey;
        const headers = msg.properties.headers || {};
        const traceId =
          (headers['x-trace-id'] as string) ||
          crypto.randomBytes(16).toString('hex');
        const retryCount = Number(headers['x-retry-count'] || 0);

        try {
          const parsed = JSON.parse(msg.content.toString()) as T;
          const eventId =
            msg.properties.messageId ||
            (headers['x-event-id'] as string) ||
            (parsed as any)?.eventId ||
            undefined;
          await handler(parsed, routingKey, traceId, eventId);
          this.channel?.ack(msg);
        } catch (err: any) {
          const currentAttempt = retryCount + 1;
          const eventId =
            msg.properties.messageId ||
            (headers['x-event-id'] as string) ||
            undefined;
          this.logger.error(
            `[${this.options.serviceName}] [traceId=${traceId}] Attempt ${currentAttempt}/${MAX_RMQ_RETRY_ATTEMPTS} failed on queue "${queueName}" (${routingKey}): ${err?.message || err}`,
          );

          if (currentAttempt < MAX_RMQ_RETRY_ATTEMPTS) {
            // Retry by re-queueing to the same queue with incremented x-retry-count and preserved eventId
            this.channel?.sendToQueue(queueName, msg.content, {
              persistent: true,
              contentType: 'application/json',
              messageId: eventId,
              headers: {
                ...headers,
                'x-trace-id': traceId,
                ...(eventId ? { 'x-event-id': eventId } : {}),
                'x-retry-count': currentAttempt,
              },
            });
            this.channel?.ack(msg);
          } else {
            // Exhausted all 3 attempts: NACK with requeue=false so RabbitMQ routes to Dead Letter Exchange (shop.dlx -> shop.dlq)
            this.logger.warn(
              `[${this.options.serviceName}] [traceId=${traceId}] Routing failed message on "${queueName}" to Dead Letter Queue (${SHOP_DLQ_QUEUE}) after ${MAX_RMQ_RETRY_ATTEMPTS} failed attempts`,
            );
            this.channel?.nack(msg, false, false);
          }
        } finally {
          this.inFlightCount = Math.max(0, this.inFlightCount - 1);
        }
      },
    );

    this.consumerTags.push(consumerTag);

    this.logger.log(
      `[${this.options.serviceName}] Subscribed queue "${queueName}" (DLX: ${SHOP_DLX_EXCHANGE}) to keys: [${routingKeys.join(', ')}]`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    this.isConnected = false;

    try {
      // Stop accepting new AMQP deliveries before draining in-flight handlers
      if (this.channel && this.consumerTags.length > 0) {
        for (const tag of this.consumerTags) {
          try {
            await this.channel.cancel(tag);
          } catch {
            // Consumer may already be cancelled
          }
        }
        this.consumerTags.length = 0;
      }

      // Wait briefly (up to 5s) for active handlers to finish cleanly on SIGTERM
      const deadline = Date.now() + 5000;
      while (this.inFlightCount > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      await this.channel?.close();
      await this.connection?.close();
    } catch {
      // Ignore shutdown close errors
    } finally {
      this.channel = null;
      this.connection = null;
    }
  }
}

@Global()
@Module({})
export class RabbitMQModule {
  static forRoot(options: RmqModuleOptions): DynamicModule {
    return {
      module: RabbitMQModule,
      providers: [
        {
          provide: RMQ_MODULE_OPTIONS,
          useValue: options,
        },
        RabbitMQService,
      ],
      exports: [RabbitMQService],
    };
  }
}
