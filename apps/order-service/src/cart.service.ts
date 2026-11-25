import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import Redis from 'ioredis';
import { AddCartItemDto, CartDto, CartItemDto } from '@shop/contracts';

export const REDIS_CLIENT = 'REDIS_CLIENT';
export const CART_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

@Injectable()
export class CartService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CartService.name);
  private readonly redis: Redis;

  constructor(@Optional() @Inject(REDIS_CLIENT) redisClient?: Redis) {
    this.redis =
      redisClient ||
      new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
        lazyConnect: true,
      });
  }

  async onModuleInit(): Promise<void> {
    if (this.redis.status === 'wait') {
      try {
        await this.redis.connect();
      } catch (err: any) {
        this.logger.warn(`Redis cart connection warning: ${err?.message || err}`);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // Ignore shutdown error
    }
  }

  async pingRedis(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  getCartKey(userId: string): string {
    return `cart:${userId}`;
  }

  async getCart(userId: string): Promise<CartDto> {
    const key = this.getCartKey(userId);
    const raw = await this.redis.get(key);
    if (!raw) {
      return {
        userId,
        items: [],
        subtotal: 0,
        updatedAt: new Date().toISOString(),
      };
    }

    // Auto-extend sliding 14-day TTL on activity
    await this.redis.expire(key, CART_TTL_SECONDS);

    const parsed = JSON.parse(raw) as {
      items: CartItemDto[];
      updatedAt: string;
    };
    const items = parsed.items || [];
    const subtotal = this.calculateSubtotal(items);

    return {
      userId,
      items,
      subtotal,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
    };
  }

  async addItem(userId: string, dto: AddCartItemDto): Promise<CartDto> {
    if (dto.quantity <= 0) {
      throw new BadRequestException('Quantity must be greater than zero');
    }

    const current = await this.getCart(userId);
    const existingIndex = current.items.findIndex(
      (item) => item.productId === dto.productId,
    );

    if (existingIndex >= 0) {
      current.items[existingIndex].quantity += dto.quantity;
      current.items[existingIndex].unitPrice = Number(dto.unitPrice);
      current.items[existingIndex].productTitle = dto.productTitle;
      if (dto.image) {
        current.items[existingIndex].image = dto.image;
      }
    } else {
      current.items.push({
        productId: dto.productId,
        productTitle: dto.productTitle,
        unitPrice: Number(dto.unitPrice),
        quantity: dto.quantity,
        image: dto.image,
      });
    }

    return this.saveCart(userId, current.items);
  }

  async updateQuantity(
    userId: string,
    productId: string,
    quantity: number,
  ): Promise<CartDto> {
    if (quantity < 0) {
      throw new BadRequestException('Quantity cannot be negative');
    }

    const current = await this.getCart(userId);
    const filteredItems =
      quantity === 0
        ? current.items.filter((i) => i.productId !== productId)
        : current.items.map((item) =>
            item.productId === productId ? { ...item, quantity } : item,
          );

    return this.saveCart(userId, filteredItems);
  }

  async removeItem(userId: string, productId: string): Promise<CartDto> {
    const current = await this.getCart(userId);
    const filtered = current.items.filter((i) => i.productId !== productId);
    return this.saveCart(userId, filtered);
  }

  async clearCart(userId: string): Promise<{ cleared: boolean }> {
    const key = this.getCartKey(userId);
    await this.redis.del(key);
    return { cleared: true };
  }

  private async saveCart(
    userId: string,
    items: CartItemDto[],
  ): Promise<CartDto> {
    const key = this.getCartKey(userId);
    const updatedAt = new Date().toISOString();
    const subtotal = this.calculateSubtotal(items);

    await this.redis.set(
      key,
      JSON.stringify({ items, updatedAt }),
      'EX',
      CART_TTL_SECONDS,
    );

    return {
      userId,
      items,
      subtotal,
      updatedAt,
    };
  }

  private calculateSubtotal(items: CartItemDto[]): number {
    const sum = items.reduce(
      (acc, item) => acc + Number(item.unitPrice) * item.quantity,
      0,
    );
    return Number(sum.toFixed(2));
  }
}
