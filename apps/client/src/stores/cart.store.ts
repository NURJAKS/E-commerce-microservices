import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  CartDto,
  CartItemDto,
  OrderDto,
  ProductDto,
  ValidateDiscountResult,
} from '@shop/contracts';
import { http } from '../api/http';
import { socketManager } from '../services/socket';
import { useAuthStore } from './auth.store';
import { useToastStore } from './toast.store';

export const useCartStore = defineStore('cart', () => {
  const items = ref<CartItemDto[]>([]);
  const isOpen = ref<boolean>(false);
  const promoCode = ref<string>('');
  const appliedDiscount = ref<ValidateDiscountResult | null>(null);
  const promoError = ref<string>('');
  const loading = ref<boolean>(false);
  const currentIdempotencyKey = ref<string>('');

  function ensureIdempotencyKey(): string {
    if (!currentIdempotencyKey.value) {
      currentIdempotencyKey.value =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    return currentIdempotencyKey.value;
  }

  const itemCount = computed(() =>
    items.value.reduce((sum, item) => sum + item.quantity, 0),
  );

  const subtotal = computed(() => {
    const raw = items.value.reduce(
      (sum, item) => sum + Number(item.unitPrice) * item.quantity,
      0,
    );
    return Number(raw.toFixed(2));
  });

  const discountSavings = computed(() => {
    if (!appliedDiscount.value || !appliedDiscount.value.valid) {
      return 0;
    }
    const pct = (subtotal.value * appliedDiscount.value.percentage) / 100;
    const raw = pct + appliedDiscount.value.fixedAmount;
    return Number(Math.min(subtotal.value, raw).toFixed(2));
  });

  const finalTotal = computed(() =>
    Number(Math.max(0, subtotal.value - discountSavings.value).toFixed(2)),
  );

  async function fetchCart() {
    const authStore = useAuthStore();
    if (!authStore.isAuthenticated) {
      items.value = [];
      return;
    }

    const { data } = await http.get<CartDto>('/cart');
    items.value = data.items || [];
  }

  async function addItem(product: ProductDto, quantity = 1) {
    const toastStore = useToastStore();

    // Optimistic UI update
    const existing = items.value.find((i) => i.productId === product.id);
    if (existing) {
      existing.quantity += quantity;
    } else {
      items.value.push({
        productId: product.id,
        productTitle: product.title,
        unitPrice: product.price,
        quantity,
        image: product.images?.[0],
      });
    }

    try {
      const { data } = await http.post<CartDto>('/cart/items', {
        productId: product.id,
        productTitle: product.title,
        unitPrice: product.price,
        quantity,
        image: product.images?.[0],
      });
      items.value = data.items;
      toastStore.show(
        'Added to Cart',
        `${product.title} added to your Redis cart`,
        'success',
      );
    } catch (err: any) {
      await fetchCart();
      throw err;
    }
  }

  async function updateQuantity(productId: string, quantity: number) {
    // Optimistic UI update
    if (quantity <= 0) {
      items.value = items.value.filter((i) => i.productId !== productId);
    } else {
      const target = items.value.find((i) => i.productId === productId);
      if (target) target.quantity = quantity;
    }

    try {
      const { data } = await http.patch<CartDto>('/cart/items', {
        productId,
        quantity,
      });
      items.value = data.items;
    } catch {
      await fetchCart();
    }
  }

  async function removeItem(productId: string) {
    items.value = items.value.filter((i) => i.productId !== productId);
    try {
      const { data } = await http.delete<CartDto>(`/cart/items/${productId}`);
      items.value = data.items;
    } catch {
      await fetchCart();
    }
  }

  async function applyPromoCode(codeInput?: string) {
    const targetCode = (codeInput ?? promoCode.value).trim().toUpperCase();
    promoCode.value = targetCode;
    promoError.value = '';

    if (!targetCode) {
      appliedDiscount.value = null;
      return;
    }

    const { data } = await http.get<ValidateDiscountResult>(
      `/catalog/discounts/validate/${encodeURIComponent(targetCode)}`,
    );

    if (!data.valid) {
      appliedDiscount.value = null;
      promoError.value = data.reason || 'Invalid promo code';
      return;
    }

    appliedDiscount.value = data;
  }

  function clearPromoCode() {
    promoCode.value = '';
    appliedDiscount.value = null;
    promoError.value = '';
  }

  async function checkout(): Promise<OrderDto> {
    loading.value = true;
    const idempotencyKey = ensureIdempotencyKey();
    const activePromo = appliedDiscount.value?.valid
      ? appliedDiscount.value.code
      : undefined;

    socketManager.notifyCheckoutInitiated({
      idempotencyKey,
      discountCode: activePromo,
      subtotal: finalTotal.value,
      itemCount: itemCount.value,
      timestamp: new Date().toISOString(),
    });

    try {
      const { data } = await http.post<OrderDto>(
        '/orders/checkout',
        {
          discountCode: activePromo,
        },
        {
          headers: {
            'X-Idempotency-Key': idempotencyKey,
          },
        },
      );
      items.value = [];
      clearPromoCode();
      currentIdempotencyKey.value = '';
      isOpen.value = false;
      return data;
    } finally {
      loading.value = false;
    }
  }

  return {
    items,
    isOpen,
    promoCode,
    appliedDiscount,
    promoError,
    loading,
    itemCount,
    subtotal,
    discountSavings,
    finalTotal,
    fetchCart,
    addItem,
    updateQuantity,
    removeItem,
    applyPromoCode,
    clearPromoCode,
    checkout,
  };
});
