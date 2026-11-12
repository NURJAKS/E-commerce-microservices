import { describe, expect, it, beforeEach, vi } from 'vitest';
import { CART_TTL_SECONDS, CartService } from './cart.service';

class InMemoryRedisMock {
  public store = new Map<string, { value: string; ttl?: number }>();
  public status = 'ready';

  get = vi.fn(async (key: string) => {
    return this.store.get(key)?.value ?? null;
  });

  set = vi.fn(
    async (key: string, value: string, _mode?: string, ttl?: number) => {
      this.store.set(key, { value, ttl });
      return 'OK';
    },
  );

  expire = vi.fn(async (key: string, ttl: number) => {
    const entry = this.store.get(key);
    if (entry) {
      entry.ttl = ttl;
      return 1;
    }
    return 0;
  });

  del = vi.fn(async (key: string) => {
    this.store.delete(key);
    return 1;
  });

  quit = vi.fn(async () => 'OK');
}

describe('CartService — Redis Integration Test (with Mocked Redis)', () => {
  let redisMock: InMemoryRedisMock;
  let cartService: CartService;
  const userId = 'user-redis-test-1';

  beforeEach(() => {
    redisMock = new InMemoryRedisMock();
    cartService = new CartService(redisMock as any);
  });

  it('stores cart under cart:{userId} with a 14-day TTL and computes subtotal', async () => {
    const cart = await cartService.addItem(userId, {
      productId: 'prod-101',
      productTitle: 'Mechanical Keyboard',
      unitPrice: 150,
      quantity: 2,
    });

    expect(cart.userId).toBe(userId);
    expect(cart.items).toHaveLength(1);
    expect(cart.subtotal).toBe(300);

    expect(redisMock.set).toHaveBeenCalledWith(
      `cart:${userId}`,
      expect.any(String),
      'EX',
      CART_TTL_SECONDS,
    );
  });

  it('merges quantities when adding the same product twice and refreshes TTL on getCart', async () => {
    await cartService.addItem(userId, {
      productId: 'prod-101',
      productTitle: 'Mechanical Keyboard',
      unitPrice: 150,
      quantity: 1,
    });

    await cartService.addItem(userId, {
      productId: 'prod-101',
      productTitle: 'Mechanical Keyboard',
      unitPrice: 150,
      quantity: 2,
    });

    const cart = await cartService.getCart(userId);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(3);
    expect(cart.subtotal).toBe(450);
    expect(redisMock.expire).toHaveBeenCalledWith(
      `cart:${userId}`,
      CART_TTL_SECONDS,
    );
  });

  it('updates item quantity, removes item when quantity is 0, and clears cart', async () => {
    await cartService.addItem(userId, {
      productId: 'prod-1',
      productTitle: 'Monitor',
      unitPrice: 500,
      quantity: 1,
    });
    await cartService.addItem(userId, {
      productId: 'prod-2',
      productTitle: 'Mouse',
      unitPrice: 100,
      quantity: 1,
    });

    const updated = await cartService.updateQuantity(userId, 'prod-1', 3);
    expect(updated.subtotal).toBe(1600);

    const afterRemove = await cartService.removeItem(userId, 'prod-2');
    expect(afterRemove.items).toHaveLength(1);
    expect(afterRemove.subtotal).toBe(1500);

    await cartService.clearCart(userId);
    const empty = await cartService.getCart(userId);
    expect(empty.items).toHaveLength(0);
    expect(empty.subtotal).toBe(0);
  });
});
