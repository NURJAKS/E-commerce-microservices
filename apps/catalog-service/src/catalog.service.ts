import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import {
  CategoryDto,
  CreateCategoryDto,
  CreateDiscountDto,
  CreateProductDto,
  DiscountDto,
  OrderCreatedEvent,
  PaginatedProductsResponse,
  PaymentFailedEvent,
  ProductDto,
  ProductQueryDto,
  SagaOrderItem,
  StockFailedEvent,
  StockReservedEvent,
  UpdateProductDto,
  ValidateDiscountResult,
} from '@shop/contracts';
import { RabbitMQService, ROUTING_KEYS } from '@shop/rmq';
import { Prisma } from '@prisma/catalog-client';
import { PrismaService } from './prisma.service';

const CACHE_TTL_SECONDS = 10 * 60;

@Injectable()
export class CatalogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CatalogService.name);
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rmqService: RabbitMQService,
  ) {
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT || 6379),
      lazyConnect: true,
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.redis.connect();
    } catch (err: any) {
      this.logger.warn(`Redis connection warning: ${err?.message || err}`);
    }

    try {
      await this.seedInitialCatalog();
    } catch (err: any) {
      this.logger.warn(`Skipping catalog seed: ${err?.message || err}`);
    }

    await this.rmqService.subscribe<OrderCreatedEvent>(
      'catalog.order_created.queue',
      [ROUTING_KEYS.ORDER_CREATED],
      async (event, _rk, traceId) => this.handleOrderCreated(event, traceId),
    );

    await this.rmqService.subscribe<PaymentFailedEvent>(
      'catalog.payment_failed.queue',
      [ROUTING_KEYS.PAYMENT_FAILED],
      async (event, _rk, traceId) => this.handlePaymentFailed(event, traceId),
    );
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // Shutdown best-effort cleanup
    }
  }

  private async seedInitialCatalog(): Promise<void> {
    const count = await this.prisma.category.count();
    if (count > 0) return;

    const electronics = await this.prisma.category.create({
      data: { name: 'Electronics', slug: 'electronics' },
    });
    const audio = await this.prisma.category.create({
      data: { name: 'Audio & Wearables', slug: 'audio-wearables' },
    });
    const workspace = await this.prisma.category.create({
      data: { name: 'Workspace Accessories', slug: 'workspace-accessories' },
    });

    await this.prisma.product.createMany({
      data: [
        {
          title: 'Keychron Pro Wireless Mechanical Keyboard',
          description:
            'QMK/VIA wireless custom mechanical keyboard with hot-swappable tactile switches and CNC aluminum frame.',
          price: 189.0,
          stock: 40,
          images: [
            'https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=900&q=80',
          ],
          categoryId: workspace.id,
          isActive: true,
        },
        {
          title: 'UltraWide 34" Curved 4K Creator Monitor',
          description:
            'IPS Black panel with 98% DCI-P3 color accuracy, USB-C 90W power delivery, and built-in KVM switch.',
          price: 649.0,
          stock: 15,
          images: [
            'https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?auto=format&fit=crop&w=900&q=80',
          ],
          categoryId: electronics.id,
          isActive: true,
        },
        {
          title: 'Studio ANC Wireless Over-Ear Headphones',
          description:
            'Lossless spatial audio with adaptive active noise cancellation and 45-hour battery life.',
          price: 299.0,
          stock: 30,
          images: [
            'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=900&q=80',
          ],
          categoryId: audio.id,
          isActive: true,
        },
        {
          title: 'Ergonomic Vertical Precision Mouse',
          description:
            '8000 DPI optical sensor, magnetic scroll wheel, and multi-device Bluetooth + 2.4GHz receiver.',
          price: 99.0,
          stock: 55,
          images: [
            'https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?auto=format&fit=crop&w=900&q=80',
          ],
          categoryId: workspace.id,
          isActive: true,
        },
        {
          title: 'Thunderbolt 4 16-Port Pro Dock',
          description:
            'Dual 6K display support, 2.5GbE Ethernet, SD 4.0 UHS-II card reader, and 100W host charging.',
          price: 259.0,
          stock: 22,
          images: [
            'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?auto=format&fit=crop&w=900&q=80',
          ],
          categoryId: electronics.id,
          isActive: true,
        },
        {
          title: 'Titanium Smart Fitness & Sleep Ring',
          description:
            'Continuous HRV, SpO2, skin temperature, and sleep stage tracking in an ultralight titanium shell.',
          price: 329.0,
          stock: 18,
          images: [
            'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=900&q=80',
          ],
          categoryId: audio.id,
          isActive: true,
        },
      ],
    });

    const now = new Date();
    const future = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

    await this.prisma.discount.createMany({
      data: [
        {
          code: 'WELCOME20',
          percentage: 20,
          fixedAmount: 0,
          validFrom: new Date(now.getTime() - 86400000),
          validUntil: future,
          isActive: true,
        },
        {
          code: 'SAVE25',
          percentage: 0,
          fixedAmount: 25,
          validFrom: new Date(now.getTime() - 86400000),
          validUntil: future,
          isActive: true,
        },
        {
          code: 'FAIL_PAYMENT',
          percentage: 5,
          fixedAmount: 0,
          validFrom: new Date(now.getTime() - 86400000),
          validUntil: future,
          isActive: true,
        },
      ],
    });

    this.logger.log(
      'Seeded initial catalog categories, products, and promo codes (WELCOME20, SAVE25, FAIL_PAYMENT)',
    );
  }

  async getCategories(): Promise<CategoryDto[]> {
    const cacheKey = 'catalog:categories:all';
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Graceful degradation: serve directly from PostgreSQL if Redis is unreachable
    }

    const categories = await this.prisma.category.findMany({
      orderBy: { name: 'asc' },
    });

    const result: CategoryDto[] = categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      parentId: c.parentId,
    }));

    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(result),
        'EX',
        CACHE_TTL_SECONDS,
      );
    } catch {
      // Non-fatal cache warm failure
    }

    return result;
  }

  async createCategory(dto: CreateCategoryDto): Promise<CategoryDto> {
    const existing = await this.prisma.category.findUnique({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new ConflictException(
        `Category with slug "${dto.slug}" already exists`,
      );
    }

    const category = await this.prisma.category.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        parentId: dto.parentId || null,
      },
    });

    await this.invalidateCacheByPattern('catalog:categories:*');

    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      parentId: category.parentId,
    };
  }

  async getProducts(
    query: ProductQueryDto,
  ): Promise<PaginatedProductsResponse> {
    const page = Number(query.page || 1);
    const limit = Number(query.limit || 12);
    const search = (query.search || '').trim();
    const categoryId = query.categoryId || '';

    const cacheKey = `catalog:products:list:p=${page}:l=${limit}:c=${categoryId}:s=${search}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Graceful degradation to DB
    }

    const where: any = { isActive: true };
    if (categoryId) {
      where.categoryId = categoryId;
    }
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { category: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    const response: PaginatedProductsResponse = {
      items: items.map((p) => this.toProductDto(p)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };

    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(response),
        'EX',
        CACHE_TTL_SECONDS,
      );
    } catch {
      // Non-fatal cache warm failure
    }

    return response;
  }

  async getProductById(id: string): Promise<ProductDto> {
    const cacheKey = `catalog:products:item:${id}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Graceful degradation to DB
    }

    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { category: true },
    });
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }

    const dto = this.toProductDto(product);
    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(dto),
        'EX',
        CACHE_TTL_SECONDS,
      );
    } catch {
      // Non-fatal cache warm failure
    }

    return dto;
  }

  async createProduct(dto: CreateProductDto): Promise<ProductDto> {
    const product = await this.prisma.product.create({
      data: {
        title: dto.title,
        description: dto.description,
        price: dto.price,
        stock: dto.stock,
        images: dto.images || [],
        categoryId: dto.categoryId,
        isActive: dto.isActive ?? true,
      },
      include: { category: true },
    });

    await this.invalidateCacheByPattern('catalog:products:*');
    return this.toProductDto(product);
  }

  async updateProduct(id: string, dto: UpdateProductDto): Promise<ProductDto> {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Product ${id} not found`);
    }

    const updated = await this.prisma.product.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.price !== undefined ? { price: dto.price } : {}),
        ...(dto.stock !== undefined ? { stock: dto.stock } : {}),
        ...(dto.images !== undefined ? { images: dto.images } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      include: { category: true },
    });

    await this.invalidateCacheByPattern('catalog:products:*');
    return this.toProductDto(updated);
  }

  async deleteProduct(id: string): Promise<{ deleted: boolean }> {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Product ${id} not found`);
    }

    await this.prisma.product.delete({ where: { id } });
    await this.invalidateCacheByPattern('catalog:products:*');
    return { deleted: true };
  }

  async getDiscounts(): Promise<DiscountDto[]> {
    const discounts = await this.prisma.discount.findMany({
      orderBy: { code: 'asc' },
    });
    return discounts.map((d) => ({
      id: d.id,
      code: d.code,
      percentage: d.percentage,
      fixedAmount: Number(d.fixedAmount),
      validFrom: d.validFrom.toISOString(),
      validUntil: d.validUntil.toISOString(),
      isActive: d.isActive,
    }));
  }

  async createDiscount(dto: CreateDiscountDto): Promise<DiscountDto> {
    const normalizedCode = dto.code.trim().toUpperCase();
    const existing = await this.prisma.discount.findUnique({
      where: { code: normalizedCode },
    });
    if (existing) {
      throw new ConflictException(
        `Discount code "${normalizedCode}" already exists`,
      );
    }

    const discount = await this.prisma.discount.create({
      data: {
        code: normalizedCode,
        percentage: dto.percentage ?? 0,
        fixedAmount: dto.fixedAmount ?? 0,
        validFrom: new Date(dto.validFrom),
        validUntil: new Date(dto.validUntil),
        isActive: dto.isActive ?? true,
      },
    });

    return {
      id: discount.id,
      code: discount.code,
      percentage: discount.percentage,
      fixedAmount: Number(discount.fixedAmount),
      validFrom: discount.validFrom.toISOString(),
      validUntil: discount.validUntil.toISOString(),
      isActive: discount.isActive,
    };
  }

  async validateDiscount(code: string): Promise<ValidateDiscountResult> {
    const normalized = (code || '').trim().toUpperCase();
    if (!normalized) {
      return {
        valid: false,
        code: '',
        percentage: 0,
        fixedAmount: 0,
        reason: 'Empty discount code',
      };
    }

    const discount = await this.prisma.discount.findUnique({
      where: { code: normalized },
    });

    if (!discount || !discount.isActive) {
      return {
        valid: false,
        code: normalized,
        percentage: 0,
        fixedAmount: 0,
        reason: 'Promo code not found or inactive',
      };
    }

    const now = Date.now();
    if (
      now < discount.validFrom.getTime() ||
      now > discount.validUntil.getTime()
    ) {
      return {
        valid: false,
        code: normalized,
        percentage: 0,
        fixedAmount: 0,
        reason: 'Promo code is outside its validity period',
      };
    }

    return {
      valid: true,
      code: discount.code,
      percentage: discount.percentage,
      fixedAmount: Number(discount.fixedAmount),
    };
  }

  async checkStock(
    items: Array<{ productId: string; quantity: number }>,
  ): Promise<{ available: boolean; unavailableItem?: string }> {
    for (const item of items) {
      const product = await this.prisma.product.findUnique({
        where: { id: item.productId },
      });
      if (!product || !product.isActive || product.stock < item.quantity) {
        return {
          available: false,
          unavailableItem: product?.title || item.productId,
        };
      }
    }
    return { available: true };
  }

  async handleOrderCreated(
    event: OrderCreatedEvent,
    traceId?: string,
  ): Promise<void> {
    this.logger.log(
      `[Saga] [traceId=${traceId || 'n/a'}] Processing order.created for order ${event.orderId} (${event.items.length} items)`,
    );

    try {
      // Optimistic Locking (CAS on `version`) + Serializable isolation prevents overselling under concurrent checkouts
      await this.prisma.$transaction(
        async (tx) => {
          for (const item of event.items) {
            const current = await tx.product.findUnique({
              where: { id: item.productId },
            });

            if (!current || !current.isActive || current.stock < item.quantity) {
              throw new BadRequestException(
                `Out of stock for product "${item.productTitle}" (${item.productId})`,
              );
            }

            const updatedCount = await tx.$executeRaw`
              UPDATE "Product"
              SET "stock" = "stock" - ${item.quantity},
                  "version" = "version" + 1,
                  "updatedAt" = NOW()
              WHERE "id" = ${item.productId}::uuid
                AND "version" = ${current.version}
                AND "stock" >= ${item.quantity}
                AND "isActive" = true
            `;

            if (updatedCount === 0) {
              throw new ConflictException(
                `Optimistic lock or stock race condition detected for product "${item.productTitle}"`,
              );
            }
          }
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );

      await this.invalidateCacheByPattern('catalog:products:*');

      const reservedEvent: StockReservedEvent = {
        orderId: event.orderId,
        userId: event.userId,
        userEmail: event.userEmail,
        items: event.items,
        totalAmount: event.totalAmount,
        discountCode: event.discountCode,
        reservedAt: new Date().toISOString(),
      };

      await this.rmqService.publish(
        ROUTING_KEYS.STOCK_RESERVED,
        reservedEvent,
        traceId,
      );
    } catch (err: any) {
      this.logger.warn(
        `[Saga] [traceId=${traceId || 'n/a'}] Stock reservation failed for order ${event.orderId}: ${err?.message || err}`,
      );

      const failedEvent: StockFailedEvent = {
        orderId: event.orderId,
        userId: event.userId,
        userEmail: event.userEmail,
        reason: err?.message || 'Out of stock',
        failedAt: new Date().toISOString(),
      };

      await this.rmqService.publish(
        ROUTING_KEYS.STOCK_FAILED,
        failedEvent,
        traceId,
      );
    }
  }

  async handlePaymentFailed(
    event: PaymentFailedEvent,
    traceId?: string,
  ): Promise<void> {
    this.logger.log(
      `[Saga Compensation] [traceId=${traceId || 'n/a'}] Restoring stock for failed payment on order ${event.orderId}`,
    );

    await this.compensateStock(event.items);
    await this.invalidateCacheByPattern('catalog:products:*');
  }

  // Saga Compensating Transaction: restore reserved inventory if downstream payment fails
  async compensateStock(items: SagaOrderItem[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const item of items) {
        await tx.$executeRaw`
          UPDATE "Product"
          SET "stock" = "stock" + ${item.quantity},
              "version" = "version" + 1,
              "updatedAt" = NOW()
          WHERE "id" = ${item.productId}::uuid
        `;
      }
    });
  }

  async invalidateCacheByPattern(pattern: string): Promise<void> {
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } while (cursor !== '0');
    } catch (err: any) {
      this.logger.warn(`Cache invalidation warning: ${err?.message || err}`);
    }
  }

  private toProductDto(product: any): ProductDto {
    return {
      id: product.id,
      title: product.title,
      description: product.description,
      price: Number(product.price),
      stock: product.stock,
      images: product.images || [],
      categoryId: product.categoryId,
      category: product.category
        ? {
            id: product.category.id,
            name: product.category.name,
            slug: product.category.slug,
            parentId: product.category.parentId,
          }
        : undefined,
      isActive: product.isActive,
      version: product.version ?? 1,
    };
  }
}
