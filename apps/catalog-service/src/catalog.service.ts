import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
  CreateReviewDto,
  DiscountDto,
  OrderCreatedEvent,
  PaginatedProductsResponse,
  PaymentFailedEvent,
  PaymentRefundedEvent,
  PaymentSucceededEvent,
  PopularSearchDto,
  ProductDto,
  ProductQueryDto,
  ProductRestockedEvent,
  ProductReviewsResponse,
  ProductSuggestionDto,
  ReviewDto,
  SagaOrderItem,
  StockCheckQuotedItem,
  StockCheckResponse,
  StockFailedEvent,
  StockReservedEvent,
  UpdateDiscountDto,
  UpdateProductDto,
  ValidateDiscountResult,
} from '@shop/contracts';
import { isPrismaUniqueConstraintError } from '@shop/common';
import { RabbitMQService, ROUTING_KEYS } from '@shop/rmq';
import { Prisma } from '@prisma/catalog-client';
import { PrismaService } from './prisma.service';

export const CACHE_TTL_BASE_SECONDS = 10 * 60;
export const CACHE_TTL_JITTER_SECONDS = 60;
export const POPULAR_SEARCHES_KEY = 'catalog:search:popular';
export const RECENTLY_VIEWED_MAX_ITEMS = 12;
export const RECENTLY_VIEWED_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

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

  getCacheTtlWithJitter(
    baseSeconds = CACHE_TTL_BASE_SECONDS,
    jitterSeconds = CACHE_TTL_JITTER_SECONDS,
  ): number {
    const offset =
      Math.floor(Math.random() * (jitterSeconds * 2 + 1)) - jitterSeconds;
    return Math.max(1, baseSeconds + offset);
  }

  async pingRedis(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
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

    try {
      await this.ensureSearchIndexes();
    } catch (err: any) {
      this.logger.warn(
        `Search index initialization warning: ${err?.message || err}`,
      );
    }

    await this.rmqService.subscribe<OrderCreatedEvent>(
      'catalog.order_created.queue',
      [ROUTING_KEYS.ORDER_CREATED],
      async (event, _rk, traceId, eventId) =>
        this.handleOrderCreated(event, traceId, eventId),
    );

    await this.rmqService.subscribe<PaymentFailedEvent>(
      'catalog.payment_failed.queue',
      [ROUTING_KEYS.PAYMENT_FAILED],
      async (event, _rk, traceId, eventId) =>
        this.handlePaymentFailed(event, traceId, eventId),
    );

    await this.rmqService.subscribe<PaymentRefundedEvent>(
      'catalog.payment_refunded.queue',
      [ROUTING_KEYS.PAYMENT_REFUNDED],
      async (event, _rk, traceId, eventId) =>
        this.handlePaymentRefunded(event, traceId, eventId),
    );

    await this.rmqService.subscribe<PaymentSucceededEvent>(
      'catalog.payment_succeeded.queue',
      [ROUTING_KEYS.PAYMENT_SUCCEEDED],
      async (event, _rk, traceId, eventId) =>
        this.handlePaymentSucceeded(event, traceId, eventId),
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
        this.getCacheTtlWithJitter(),
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

  async ensureSearchIndexes(): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
    );
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_product_search_fts
      ON "Product"
      USING GIN (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("description", '')))
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_product_title_trgm
      ON "Product"
      USING GIN ("title" gin_trgm_ops)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_product_description_trgm
      ON "Product"
      USING GIN ("description" gin_trgm_ops)
    `);
    this.logger.log(
      'Ensured PostgreSQL Full-Text Search (tsvector + GIN) and pg_trgm fuzzy indexes on Product',
    );
  }

  async getProducts(
    query: ProductQueryDto,
  ): Promise<PaginatedProductsResponse> {
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 12)));
    const search = (query.search || '').trim();
    const categoryId = (query.categoryId || '').trim();
    const minPrice =
      query.minPrice !== undefined && query.minPrice !== null && String(query.minPrice) !== ''
        ? Number(query.minPrice)
        : undefined;
    const maxPrice =
      query.maxPrice !== undefined && query.maxPrice !== null && String(query.maxPrice) !== ''
        ? Number(query.maxPrice)
        : undefined;
    const inStockOnly = Boolean(query.inStockOnly);
    const sortBy = query.sortBy || (search ? 'relevance' : 'newest');

    if (search) {
      void this.recordSearchQuery(search);
    }

    const cacheKey = `catalog:products:list:p=${page}:l=${limit}:c=${categoryId}:s=${search.toLowerCase()}:min=${minPrice ?? ''}:max=${maxPrice ?? ''}:st=${inStockOnly ? 1 : 0}:sort=${sortBy}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Graceful degradation to DB
    }

    let response: PaginatedProductsResponse;

    if (search) {
      response = await this.searchProductsFullText({
        search,
        categoryId: categoryId || undefined,
        minPrice,
        maxPrice,
        inStockOnly,
        sortBy,
        page,
        limit,
      });
    } else {
      const where: any = { isActive: true };
      if (categoryId) {
        where.categoryId = categoryId;
      }
      if (minPrice !== undefined || maxPrice !== undefined) {
        where.price = {};
        if (minPrice !== undefined && Number.isFinite(minPrice)) {
          where.price.gte = minPrice;
        }
        if (maxPrice !== undefined && Number.isFinite(maxPrice)) {
          where.price.lte = maxPrice;
        }
      }
      if (inStockOnly) {
        where.stock = { gt: 0 };
      }

      const orderBy: any =
        sortBy === 'price_asc'
          ? { price: 'asc' }
          : sortBy === 'price_desc'
            ? { price: 'desc' }
            : { createdAt: 'desc' };

      const [items, total] = await Promise.all([
        this.prisma.product.findMany({
          where,
          include: { category: true },
          orderBy,
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.product.count({ where }),
      ]);

      response = {
        items: items.map((p) => this.toProductDto(p)),
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      };
    }

    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(response),
        'EX',
        this.getCacheTtlWithJitter(),
      );
    } catch {
      // Non-fatal cache warm failure
    }

    return response;
  }

  private async searchProductsFullText(params: {
    search: string;
    categoryId?: string;
    minPrice?: number;
    maxPrice?: number;
    inStockOnly: boolean;
    sortBy: string;
    page: number;
    limit: number;
  }): Promise<PaginatedProductsResponse> {
    const {
      search,
      categoryId,
      minPrice,
      maxPrice,
      inStockOnly,
      sortBy,
      page,
      limit,
    } = params;
    const offset = (page - 1) * limit;
    const likePattern = `%${search}%`;

    const conditions: Prisma.Sql[] = [
      Prisma.sql`p."isActive" = true`,
      Prisma.sql`(
        to_tsvector('english', coalesce(p."title", '') || ' ' || coalesce(p."description", ''))
          @@ websearch_to_tsquery('english', ${search})
        OR similarity(p."title", ${search}) >= 0.2
        OR word_similarity(${search}, p."title") >= 0.35
        OR word_similarity(${search}, p."description") >= 0.45
        OR p."title" ILIKE ${likePattern}
        OR p."description" ILIKE ${likePattern}
      )`,
    ];

    if (categoryId) {
      conditions.push(Prisma.sql`p."categoryId" = ${categoryId}::uuid`);
    }
    if (minPrice !== undefined && Number.isFinite(minPrice)) {
      conditions.push(Prisma.sql`p."price" >= ${minPrice}`);
    }
    if (maxPrice !== undefined && Number.isFinite(maxPrice)) {
      conditions.push(Prisma.sql`p."price" <= ${maxPrice}`);
    }
    if (inStockOnly) {
      conditions.push(Prisma.sql`p."stock" > 0`);
    }

    const whereClause = Prisma.join(conditions, ' AND ');

    const orderClause =
      sortBy === 'price_asc'
        ? Prisma.sql`ORDER BY p."price" ASC, relevance DESC`
        : sortBy === 'price_desc'
          ? Prisma.sql`ORDER BY p."price" DESC, relevance DESC`
          : sortBy === 'newest'
            ? Prisma.sql`ORDER BY p."createdAt" DESC, relevance DESC`
            : Prisma.sql`ORDER BY relevance DESC, p."createdAt" DESC`;

    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<Array<any>>`
        SELECT
          p."id",
          p."title",
          p."description",
          p."price",
          p."stock",
          p."images",
          p."categoryId",
          p."isActive",
          p."version",
          p."avgRating",
          p."reviewsCount",
          c."id" AS "cat_id",
          c."name" AS "cat_name",
          c."slug" AS "cat_slug",
          c."parentId" AS "cat_parentId",
          (
            ts_rank(
              to_tsvector('english', coalesce(p."title", '') || ' ' || coalesce(p."description", '')),
              websearch_to_tsquery('english', ${search})
            ) * 2.0
            + GREATEST(similarity(p."title", ${search}), word_similarity(${search}, p."title"))
          ) AS relevance
        FROM "Product" p
        LEFT JOIN "Category" c ON c."id" = p."categoryId"
        WHERE ${whereClause}
        ${orderClause}
        LIMIT ${limit}
        OFFSET ${offset}
      `,
      this.prisma.$queryRaw<Array<{ total: bigint | number }>>`
        SELECT COUNT(*)::bigint AS total
        FROM "Product" p
        WHERE ${whereClause}
      `,
    ]);

    const total = Number(countRows[0]?.total ?? 0);
    const items: ProductDto[] = rows.map((r) =>
      this.toProductDto({
        id: r.id,
        title: r.title,
        description: r.description,
        price: r.price,
        stock: r.stock,
        images: r.images,
        categoryId: r.categoryId,
        isActive: r.isActive,
        version: r.version,
        avgRating: r.avgRating,
        reviewsCount: r.reviewsCount,
        category: r.cat_id
          ? {
              id: r.cat_id,
              name: r.cat_name,
              slug: r.cat_slug,
              parentId: r.cat_parentId,
            }
          : undefined,
      }),
    );

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async autocompleteProducts(
    rawQuery: string,
    limit = 6,
  ): Promise<ProductSuggestionDto[]> {
    const q = (rawQuery || '').trim();
    if (q.length < 2) {
      return [];
    }
    const safeLimit = Math.min(12, Math.max(1, Number(limit || 6)));
    const likePattern = `%${q}%`;

    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT
        p."id",
        p."title",
        p."price",
        p."stock",
        p."images",
        c."name" AS "categoryName",
        GREATEST(similarity(p."title", ${q}), word_similarity(${q}, p."title")) AS score
      FROM "Product" p
      LEFT JOIN "Category" c ON c."id" = p."categoryId"
      WHERE p."isActive" = true
        AND (
          p."title" ILIKE ${likePattern}
          OR word_similarity(${q}, p."title") >= 0.3
          OR similarity(p."title", ${q}) >= 0.2
          OR to_tsvector('english', coalesce(p."title", '') || ' ' || coalesce(p."description", ''))
             @@ websearch_to_tsquery('english', ${q})
        )
      ORDER BY
        CASE WHEN p."title" ILIKE ${q + '%'} THEN 1 ELSE 0 END DESC,
        score DESC,
        p."stock" DESC
      LIMIT ${safeLimit}
    `;

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      price: Number(r.price),
      stock: Number(r.stock),
      image: r.images?.[0] ? this.resolveImageUrl(r.images[0]) : undefined,
      categoryName: r.categoryName || undefined,
    }));
  }

  async recordSearchQuery(term: string): Promise<void> {
    const normalized = (term || '').trim().toLowerCase();
    if (normalized.length < 2 || normalized.length > 60) {
      return;
    }
    try {
      await this.redis.zincrby(POPULAR_SEARCHES_KEY, 1, normalized);
    } catch {
      // Non-fatal analytics write failure
    }
  }

  async getPopularSearches(limit = 8): Promise<PopularSearchDto[]> {
    const safeLimit = Math.min(20, Math.max(1, Number(limit || 8)));
    try {
      const raw = await this.redis.zrevrange(
        POPULAR_SEARCHES_KEY,
        0,
        safeLimit - 1,
        'WITHSCORES',
      );
      const results: PopularSearchDto[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        results.push({
          term: raw[i],
          count: Math.round(Number(raw[i + 1] || 0)),
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  getRecentlyViewedKey(viewerId: string): string {
    return `catalog:recent:${viewerId}`;
  }

  async recordProductView(
    viewerId: string,
    productId: string,
  ): Promise<{ recorded: boolean }> {
    const cleanViewer = (viewerId || '').trim();
    if (!cleanViewer || !productId) {
      return { recorded: false };
    }
    const key = this.getRecentlyViewedKey(cleanViewer);
    try {
      await this.redis.zadd(key, Date.now(), productId);
      await this.redis.zremrangebyrank(key, 0, -(RECENTLY_VIEWED_MAX_ITEMS + 1));
      await this.redis.expire(key, RECENTLY_VIEWED_TTL_SECONDS);
      return { recorded: true };
    } catch {
      return { recorded: false };
    }
  }

  async getRecentlyViewedProducts(
    viewerId: string,
    limit = 6,
  ): Promise<ProductDto[]> {
    const cleanViewer = (viewerId || '').trim();
    if (!cleanViewer) {
      return [];
    }
    const safeLimit = Math.min(
      RECENTLY_VIEWED_MAX_ITEMS,
      Math.max(1, Number(limit || 6)),
    );
    const key = this.getRecentlyViewedKey(cleanViewer);

    let productIds: string[] = [];
    try {
      productIds = await this.redis.zrevrange(key, 0, safeLimit - 1);
    } catch {
      return [];
    }

    if (productIds.length === 0) {
      return [];
    }

    const products = await this.prisma.product.findMany({
      where: {
        id: { in: productIds },
        isActive: true,
      },
      include: { category: true },
    });

    const byId = new Map(products.map((p) => [p.id, this.toProductDto(p)]));
    return productIds
      .map((id) => byId.get(id))
      .filter((p): p is ProductDto => Boolean(p));
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
        this.getCacheTtlWithJitter(),
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

    await this.invalidateProductCache();
    return this.toProductDto(product);
  }

  async updateProduct(id: string, dto: UpdateProductDto): Promise<ProductDto> {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Product ${id} not found`);
    }

    const stockDelta =
      dto.stock !== undefined ? dto.stock - existing.stock : 0;

    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.product.update({
        where: { id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.price !== undefined ? { price: dto.price } : {}),
          ...(dto.stock !== undefined ? { stock: dto.stock } : {}),
          ...(dto.images !== undefined ? { images: dto.images } : {}),
          ...(dto.categoryId !== undefined
            ? { categoryId: dto.categoryId }
            : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(stockDelta !== 0 ? { version: { increment: 1 } } : {}),
        },
        include: { category: true },
      });

      if (stockDelta !== 0) {
        await tx.stockMovement.create({
          data: {
            productId: id,
            delta: stockDelta,
            type: 'ADMIN_ADJUSTMENT',
            reason: `Admin updated stock from ${existing.stock} to ${dto.stock}`,
          },
        });
      }

      return saved;
    });

    await this.invalidateProductCache([id]);

    if (existing.stock === 0 && updated.stock > 0) {
      await this.emitRestockedAlerts([id]);
    }

    return this.toProductDto(updated);
  }

  async deleteProduct(id: string): Promise<{ deleted: boolean }> {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Product ${id} not found`);
    }

    await this.prisma.product.delete({ where: { id } });
    await this.invalidateProductCache([id]);
    return { deleted: true };
  }

  /**
   * Event-Driven Local Projection (no cross-DB joins):
   * On `payment.succeeded`, records `(userId, productId)` in `VerifiedPurchase` inside `catalog_db`
   * so only genuine buyers can submit Verified Purchase reviews.
   */
  async handlePaymentSucceeded(
    event: PaymentSucceededEvent,
    traceId?: string,
    eventId?: string,
  ): Promise<void> {
    const resolvedEventId =
      eventId ||
      `${ROUTING_KEYS.PAYMENT_SUCCEEDED}:${event.paymentId || event.orderId}`;

    const productIds = [
      ...new Set((event.items || []).map((i) => i.productId).filter(Boolean)),
    ];

    this.logger.log(
      `[Verified Purchase Projection] [traceId=${traceId || 'n/a'}] [eventId=${resolvedEventId}] Projecting ${productIds.length} purchased product(s) for user ${event.userId}`,
    );

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            eventId: resolvedEventId,
            eventType: ROUTING_KEYS.PAYMENT_SUCCEEDED,
          },
        });

        for (const productId of productIds) {
          await tx.verifiedPurchase.upsert({
            where: {
              userId_productId: {
                userId: event.userId,
                productId,
              },
            },
            update: {
              orderId: event.orderId,
              purchasedAt: new Date(event.paidAt || Date.now()),
            },
            create: {
              userId: event.userId,
              productId,
              orderId: event.orderId,
              purchasedAt: new Date(event.paidAt || Date.now()),
            },
          });
        }
      });
    } catch (err: any) {
      if (isPrismaUniqueConstraintError(err)) {
        this.logger.warn(
          `[Inbox] [traceId=${traceId || 'n/a'}] Duplicate payment.succeeded "${resolvedEventId}" already projected — skipping`,
        );
        return;
      }
      throw err;
    }
  }

  async getProductReviews(
    productId: string,
    viewerUserId?: string,
  ): Promise<ProductReviewsResponse> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    const reviews = await this.prisma.review.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
    });

    let canReview = false;
    let hasReviewed = false;

    if (viewerUserId) {
      hasReviewed = reviews.some((r) => r.userId === viewerUserId);
      if (!hasReviewed) {
        const verified = await this.prisma.verifiedPurchase.findUnique({
          where: {
            userId_productId: {
              userId: viewerUserId,
              productId,
            },
          },
        });
        canReview = Boolean(verified);
      }
    }

    return {
      productId,
      avgRating: Number(product.avgRating ?? 0),
      reviewsCount: product.reviewsCount ?? 0,
      canReview,
      hasReviewed,
      items: reviews.map((r) => this.toReviewDto(r)),
    };
  }

  async createProductReview(
    productId: string,
    userId: string,
    userEmail: string,
    dto: CreateReviewDto,
  ): Promise<ReviewDto> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    const verified = await this.prisma.verifiedPurchase.findUnique({
      where: {
        userId_productId: {
          userId,
          productId,
        },
      },
    });
    if (!verified) {
      throw new ForbiddenException(
        'Only customers with a verified purchase can leave a review for this product',
      );
    }

    let createdReview: any;
    try {
      createdReview = await this.prisma.$transaction(async (tx) => {
        const review = await tx.review.create({
          data: {
            productId,
            userId,
            userEmail: userEmail || `buyer-${userId.slice(0, 6)}@shop.local`,
            rating: dto.rating,
            comment: dto.comment.trim(),
          },
        });

        const agg = await tx.review.aggregate({
          where: { productId },
          _avg: { rating: true },
          _count: { id: true },
        });

        const avgRating = Number((agg._avg.rating ?? 0).toFixed(2));
        const reviewsCount = agg._count.id;

        await tx.product.update({
          where: { id: productId },
          data: { avgRating, reviewsCount },
        });

        return review;
      });
    } catch (err: any) {
      if (isPrismaUniqueConstraintError(err)) {
        throw new ConflictException('You have already reviewed this product');
      }
      throw err;
    }

    await this.invalidateProductCache([productId]);
    return this.toReviewDto(createdReview);
  }

  async subscribeStockAlert(
    productId: string,
    email: string,
    userId?: string,
  ): Promise<{ subscribed: boolean; productId: string; email: string }> {
    const normalizedEmail = (email || '').trim().toLowerCase();
    if (!normalizedEmail) {
      throw new BadRequestException(
        'Email address is required to subscribe to Back-in-Stock alerts',
      );
    }

    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }
    if (product.stock > 0) {
      throw new BadRequestException(
        'This product is currently in stock — no restock alert needed',
      );
    }

    await this.prisma.stockAlertSubscription.upsert({
      where: {
        productId_email: {
          productId,
          email: normalizedEmail,
        },
      },
      update: {
        userId: userId || null,
        notifiedAt: null,
      },
      create: {
        productId,
        email: normalizedEmail,
        userId: userId || null,
        notifiedAt: null,
      },
    });

    this.logger.log(
      `[Back-in-Stock] Subscribed ${normalizedEmail} to restock alert for product ${productId}`,
    );

    return { subscribed: true, productId, email: normalizedEmail };
  }

  async isSubscribedToStockAlert(
    productId: string,
    email?: string,
    userId?: string,
  ): Promise<{ subscribed: boolean }> {
    const normalizedEmail = (email || '').trim().toLowerCase();
    if (!normalizedEmail && !userId) {
      return { subscribed: false };
    }

    const where: any = { productId, notifiedAt: null };
    if (normalizedEmail) {
      where.email = normalizedEmail;
    } else if (userId) {
      where.userId = userId;
    }

    const existing = await this.prisma.stockAlertSubscription.findFirst({
      where,
    });
    return { subscribed: Boolean(existing) };
  }

  /**
   * Detects pending Back-in-Stock subscribers when a product transitions `stock: 0 -> >0`,
   * marks them notified, and emits `catalog.product.restocked` to RabbitMQ for batched fan-out.
   */
  async emitRestockedAlerts(
    productIds: string[],
    traceId?: string,
  ): Promise<void> {
    if (!productIds.length || !this.prisma.stockAlertSubscription) {
      return;
    }

    for (const productId of [...new Set(productIds)]) {
      try {
        const pending = await this.prisma.stockAlertSubscription.findMany({
          where: { productId, notifiedAt: null },
        });
        if (pending.length === 0) {
          continue;
        }

        const product = await this.prisma.product.findUnique({
          where: { id: productId },
        });
        if (!product || product.stock <= 0) {
          continue;
        }

        const notifiedAt = new Date();
        await this.prisma.stockAlertSubscription.updateMany({
          where: { id: { in: pending.map((s) => s.id) } },
          data: { notifiedAt },
        });

        const restockedEvent: ProductRestockedEvent = {
          productId: product.id,
          productTitle: product.title,
          price: Number(product.price),
          stock: product.stock,
          image: product.images?.[0]
            ? this.resolveImageUrl(product.images[0])
            : undefined,
          subscribers: pending.map((s) => ({
            userId: s.userId,
            email: s.email,
          })),
          restockedAt: notifiedAt.toISOString(),
        };

        await this.rmqService.publish(
          ROUTING_KEYS.PRODUCT_RESTOCKED,
          restockedEvent,
          traceId,
        );

        this.logger.log(
          `[Back-in-Stock] Emitted catalog.product.restocked for "${product.title}" (${pending.length} subscriber(s))`,
        );
      } catch (err: any) {
        this.logger.warn(
          `[Back-in-Stock] Failed emitting restock alert for ${productId}: ${err?.message || err}`,
        );
      }
    }
  }

  async getDiscounts(): Promise<DiscountDto[]> {
    const discounts = await this.prisma.discount.findMany({
      orderBy: { code: 'asc' },
    });
    return discounts.map((d) => this.toDiscountDto(d));
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
        maxUses: dto.maxUses ?? null,
        maxUsesPerUser: dto.maxUsesPerUser ?? null,
        isActive: dto.isActive ?? true,
      },
    });

    return this.toDiscountDto(discount);
  }

  async updateDiscount(
    id: string,
    dto: UpdateDiscountDto,
  ): Promise<DiscountDto> {
    const existing = await this.prisma.discount.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Discount ${id} not found`);
    }

    const updated = await this.prisma.discount.update({
      where: { id },
      data: {
        ...(dto.percentage !== undefined ? { percentage: dto.percentage } : {}),
        ...(dto.fixedAmount !== undefined
          ? { fixedAmount: dto.fixedAmount }
          : {}),
        ...(dto.validFrom !== undefined
          ? { validFrom: new Date(dto.validFrom) }
          : {}),
        ...(dto.validUntil !== undefined
          ? { validUntil: new Date(dto.validUntil) }
          : {}),
        ...(dto.maxUses !== undefined ? { maxUses: dto.maxUses } : {}),
        ...(dto.maxUsesPerUser !== undefined
          ? { maxUsesPerUser: dto.maxUsesPerUser }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });

    return this.toDiscountDto(updated);
  }

  async deleteDiscount(id: string): Promise<{ deleted: boolean }> {
    const existing = await this.prisma.discount.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Discount ${id} not found`);
    }

    await this.prisma.discount.delete({ where: { id } });
    return { deleted: true };
  }

  async validateDiscount(
    code: string,
    userId?: string,
  ): Promise<ValidateDiscountResult> {
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

    if (discount.maxUses !== null && discount.usedCount >= discount.maxUses) {
      return {
        valid: false,
        code: normalized,
        percentage: 0,
        fixedAmount: 0,
        reason: 'Promo code maximum total usage limit reached',
      };
    }

    if (userId && discount.maxUsesPerUser !== null) {
      const userRedemptions = await this.prisma.discountRedemption.count({
        where: { discountId: discount.id, userId },
      });
      if (userRedemptions >= discount.maxUsesPerUser) {
        return {
          valid: false,
          code: normalized,
          percentage: 0,
          fixedAmount: 0,
          reason: `You have already reached the per-user usage limit (${discount.maxUsesPerUser}) for "${normalized}"`,
        };
      }
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
  ): Promise<StockCheckResponse> {
    const quotedItems: StockCheckQuotedItem[] = [];
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
      quotedItems.push({
        productId: product.id,
        productTitle: product.title,
        unitPrice: Number(product.price),
        quantity: item.quantity,
      });
    }
    return { available: true, quotedItems };
  }

  async handleOrderCreated(
    event: OrderCreatedEvent,
    traceId?: string,
    eventId?: string,
  ): Promise<void> {
    const resolvedEventId =
      eventId || `${ROUTING_KEYS.ORDER_CREATED}:${event.orderId}`;

    this.logger.log(
      `[Saga] [traceId=${traceId || 'n/a'}] [eventId=${resolvedEventId}] Processing order.created for order ${event.orderId} (${event.items.length} items)`,
    );

    try {
      // Inbox Pattern (ProcessedEvent PK) + Optimistic Locking (CAS on `version`) + Serializable isolation
      // guarantees Exactly-Once stock reservation and prevents overselling under concurrent checkouts.
      await this.prisma.$transaction(
        async (tx) => {
          await tx.processedEvent.create({
            data: {
              eventId: resolvedEventId,
              eventType: ROUTING_KEYS.ORDER_CREATED,
            },
          });

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

            await tx.stockMovement.create({
              data: {
                productId: item.productId,
                orderId: event.orderId,
                delta: -item.quantity,
                type: 'ORDER_RESERVED',
                reason: `Stock reserved for order ${event.orderId}`,
              },
            });
          }

          // Atomically enforce and record promo code redemption inside the same Serializable transaction
          if (event.discountCode && tx.discount) {
            const normalizedCode = event.discountCode.trim().toUpperCase();
            const discount = await tx.discount.findUnique({
              where: { code: normalizedCode },
            });
            if (discount) {
              if (
                discount.maxUses !== null &&
                discount.usedCount >= discount.maxUses
              ) {
                throw new BadRequestException(
                  `Promo code "${normalizedCode}" usage limit reached`,
                );
              }
              if (discount.maxUsesPerUser !== null) {
                const userCount = await tx.discountRedemption.count({
                  where: { discountId: discount.id, userId: event.userId },
                });
                if (userCount >= discount.maxUsesPerUser) {
                  throw new BadRequestException(
                    `Per-user limit reached for promo code "${normalizedCode}"`,
                  );
                }
              }
              await tx.discountRedemption.create({
                data: {
                  discountId: discount.id,
                  userId: event.userId,
                  orderId: event.orderId,
                },
              });
              await tx.discount.update({
                where: { id: discount.id },
                data: { usedCount: { increment: 1 } },
              });
            }
          }
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );

      await this.invalidateProductCache(event.items.map((i) => i.productId));

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
      if (isPrismaUniqueConstraintError(err)) {
        this.logger.warn(
          `[Inbox] [traceId=${traceId || 'n/a'}] Duplicate event "${resolvedEventId}" already processed — skipping duplicate stock deduction for order ${event.orderId}`,
        );
        return;
      }

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
    eventId?: string,
  ): Promise<void> {
    const resolvedEventId =
      eventId ||
      `${ROUTING_KEYS.PAYMENT_FAILED}:${event.paymentId || event.orderId}`;

    this.logger.log(
      `[Saga Compensation] [traceId=${traceId || 'n/a'}] [eventId=${resolvedEventId}] Restoring stock for failed payment on order ${event.orderId}`,
    );

    try {
      const restockedIds: string[] = [];

      await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            eventId: resolvedEventId,
            eventType: ROUTING_KEYS.PAYMENT_FAILED,
          },
        });

        const itemProductIds = [...new Set(event.items.map((i) => i.productId))];
        if (itemProductIds.length > 0 && tx.product?.findMany) {
          const zeroStockProducts = await tx.product.findMany({
            where: { id: { in: itemProductIds }, stock: 0 },
            select: { id: true },
          });
          restockedIds.push(...zeroStockProducts.map((p) => p.id));
        }

        for (const item of event.items) {
          await tx.$executeRaw`
            UPDATE "Product"
            SET "stock" = "stock" + ${item.quantity},
                "version" = "version" + 1,
                "updatedAt" = NOW()
            WHERE "id" = ${item.productId}::uuid
          `;

          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              orderId: event.orderId,
              delta: item.quantity,
              type: 'PAYMENT_FAILED_RESTORE',
              reason: event.reason,
            },
          });
        }

        await this.releaseDiscountRedemption(tx, event.orderId);
      });

      await this.invalidateProductCache(event.items.map((i) => i.productId));
      if (restockedIds.length > 0) {
        await this.emitRestockedAlerts(restockedIds, traceId);
      }
    } catch (err: any) {
      if (isPrismaUniqueConstraintError(err)) {
        this.logger.warn(
          `[Inbox] [traceId=${traceId || 'n/a'}] Duplicate compensation event "${resolvedEventId}" already processed — skipping duplicate stock restore for order ${event.orderId}`,
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
      `[Refund Saga] [traceId=${traceId || 'n/a'}] [eventId=${resolvedEventId}] Restoring stock and writing StockMovement audit for refunded order ${event.orderId}`,
    );

    try {
      const restockedIds: string[] = [];

      await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            eventId: resolvedEventId,
            eventType: ROUTING_KEYS.PAYMENT_REFUNDED,
          },
        });

        const itemProductIds = [...new Set(event.items.map((i) => i.productId))];
        if (itemProductIds.length > 0 && tx.product?.findMany) {
          const zeroStockProducts = await tx.product.findMany({
            where: { id: { in: itemProductIds }, stock: 0 },
            select: { id: true },
          });
          restockedIds.push(...zeroStockProducts.map((p) => p.id));
        }

        for (const item of event.items) {
          await tx.$executeRaw`
            UPDATE "Product"
            SET "stock" = "stock" + ${item.quantity},
                "version" = "version" + 1,
                "updatedAt" = NOW()
            WHERE "id" = ${item.productId}::uuid
          `;

          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              orderId: event.orderId,
              delta: item.quantity,
              type: 'REFUND_RESTORE',
              reason: `Refund ${event.refundTransactionId}: ${event.reason}`,
            },
          });
        }

        await this.releaseDiscountRedemption(tx, event.orderId);
      });

      await this.invalidateProductCache(event.items.map((i) => i.productId));
      if (restockedIds.length > 0) {
        await this.emitRestockedAlerts(restockedIds, traceId);
      }
    } catch (err: any) {
      if (isPrismaUniqueConstraintError(err)) {
        this.logger.warn(
          `[Inbox] [traceId=${traceId || 'n/a'}] Duplicate refund stock event "${resolvedEventId}" already processed — skipping duplicate stock restore for order ${event.orderId}`,
        );
        return;
      }
      throw err;
    }
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

  async invalidateProductCache(productIds?: string[]): Promise<void> {
    if (productIds && productIds.length > 0) {
      const itemKeys = [...new Set(productIds)].map(
        (id) => `catalog:products:item:${id}`,
      );
      try {
        await this.redis.del(...itemKeys);
      } catch (err: any) {
        this.logger.warn(
          `Targeted cache invalidation warning: ${err?.message || err}`,
        );
      }
      await this.invalidateCacheByPattern('catalog:products:list:*');
      return;
    }
    await this.invalidateCacheByPattern('catalog:products:*');
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

  private async releaseDiscountRedemption(
    tx: any,
    orderId: string,
  ): Promise<void> {
    if (!tx.discountRedemption) return;
    const redemption = await tx.discountRedemption.findUnique({
      where: { orderId },
    });
    if (!redemption) return;

    await tx.discountRedemption.delete({ where: { id: redemption.id } });
    await tx.$executeRaw`
      UPDATE "Discount"
      SET "usedCount" = GREATEST(0, "usedCount" - 1)
      WHERE "id" = ${redemption.discountId}::uuid
    `;
  }

  private resolveImageUrl(keyOrUrl: string): string {
    if (/^https?:\/\//i.test(keyOrUrl)) {
      return keyOrUrl;
    }
    const base = (
      process.env.MINIO_PUBLIC_URL || 'http://localhost:9000'
    ).replace(/\/$/, '');
    const bucket = process.env.MINIO_BUCKET || 'products-media';
    const cleanKey = keyOrUrl.replace(/^\/+/, '');
    return `${base}/${bucket}/${cleanKey}`;
  }

  private toDiscountDto(d: any): DiscountDto {
    return {
      id: d.id,
      code: d.code,
      percentage: d.percentage,
      fixedAmount: Number(d.fixedAmount),
      validFrom: d.validFrom.toISOString(),
      validUntil: d.validUntil.toISOString(),
      maxUses: d.maxUses ?? null,
      maxUsesPerUser: d.maxUsesPerUser ?? null,
      usedCount: d.usedCount ?? 0,
      isActive: d.isActive,
    };
  }

  private toReviewDto(r: any): ReviewDto {
    return {
      id: r.id,
      productId: r.productId,
      userId: r.userId,
      userEmail: r.userEmail,
      rating: r.rating,
      comment: r.comment,
      verifiedPurchase: true,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private toProductDto(product: any): ProductDto {
    return {
      id: product.id,
      title: product.title,
      description: product.description,
      price: Number(product.price),
      stock: product.stock,
      images: (product.images || []).map((img: string) =>
        this.resolveImageUrl(img),
      ),
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
      avgRating: Number(product.avgRating ?? 0),
      reviewsCount: Number(product.reviewsCount ?? 0),
    };
  }
}
