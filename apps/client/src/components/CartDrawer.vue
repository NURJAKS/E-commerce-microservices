<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useCartStore } from '../stores/cart.store';
import { useAuthStore } from '../stores/auth.store';
import { useToastStore } from '../stores/toast.store';

const cartStore = useCartStore();
const authStore = useAuthStore();
const toastStore = useToastStore();
const router = useRouter();

async function handleApplyPromo() {
  await cartStore.applyPromoCode();
}

async function handleCheckout() {
  if (!authStore.isAuthenticated) {
    cartStore.isOpen = false;
    router.push('/login');
    return;
  }

  try {
    const order = await cartStore.checkout();
    router.push(`/orders/${order.id}`);
  } catch (err: any) {
    const msg =
      err?.response?.data?.message || err?.message || 'Checkout failed';
    toastStore.show('Checkout Error', String(msg), 'error');
  }
}
</script>

<template>
  <div
    v-if="cartStore.isOpen"
    class="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm"
    data-testid="cart-drawer"
  >
    <div
      class="relative flex h-full w-full max-w-md flex-col border-l border-slate-800 bg-slate-900 shadow-2xl"
    >
      <!-- Header -->
      <div
        class="flex items-center justify-between border-b border-slate-800 px-6 py-4"
      >
        <div>
          <h2 class="text-lg font-bold text-white">Your Redis Cart</h2>
          <p class="text-xs text-slate-400">
            14-day TTL auto-renewed in Redis (`cart:{userId}`)
          </p>
        </div>
        <button
          @click="cartStore.isOpen = false"
          class="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
          data-testid="close-cart-btn"
        >
          ✕
        </button>
      </div>

      <!-- Items List -->
      <div class="flex-1 overflow-y-auto p-6 space-y-4">
        <div
          v-if="cartStore.items.length === 0"
          class="flex flex-col items-center justify-center py-16 text-center text-slate-400"
        >
          <p class="text-base font-medium">Your cart is empty</p>
          <p class="mt-1 text-xs text-slate-500">
            Add products from the catalog to test Redis cart &amp; Saga checkout.
          </p>
        </div>

        <div
          v-for="item in cartStore.items"
          :key="item.productId"
          class="flex items-center gap-4 rounded-xl border border-slate-800 bg-slate-950/60 p-3.5"
          data-testid="cart-item"
        >
          <img
            v-if="item.image"
            :src="item.image"
            :alt="item.productTitle"
            class="h-16 w-16 rounded-lg object-cover bg-slate-800"
          />
          <div class="flex-1 min-w-0">
            <h4 class="truncate text-sm font-semibold text-white">
              {{ item.productTitle }}
            </h4>
            <p class="text-xs text-indigo-400 font-medium mt-0.5">
              ${{ Number(item.unitPrice).toFixed(2) }} each
            </p>
            <div class="mt-2 flex items-center gap-2">
              <button
                @click="
                  cartStore.updateQuantity(item.productId, item.quantity - 1)
                "
                class="h-6 w-6 rounded bg-slate-800 text-xs font-bold text-slate-200 hover:bg-slate-700"
              >
                -
              </button>
              <span
                class="text-xs font-semibold text-white px-1"
                data-testid="cart-item-qty"
              >
                {{ item.quantity }}
              </span>
              <button
                @click="
                  cartStore.updateQuantity(item.productId, item.quantity + 1)
                "
                class="h-6 w-6 rounded bg-slate-800 text-xs font-bold text-slate-200 hover:bg-slate-700"
              >
                +
              </button>
            </div>
          </div>
          <button
            @click="cartStore.removeItem(item.productId)"
            class="text-xs text-rose-400 hover:text-rose-300"
          >
            Remove
          </button>
        </div>
      </div>

      <!-- Footer: Promo Code & Summary -->
      <div
        v-if="cartStore.items.length > 0"
        class="border-t border-slate-800 bg-slate-950 p-6 space-y-4"
      >
        <div>
          <label class="block text-xs font-medium text-slate-400 mb-1.5">
            Promo Code (Try <code class="text-indigo-400">WELCOME20</code> or
            <code class="text-emerald-400">SAVE25</code>)
          </label>
          <div class="flex gap-2">
            <input
              v-model="cartStore.promoCode"
              type="text"
              placeholder="Enter promo code"
              data-testid="promo-input"
              class="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white uppercase placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <button
              @click="handleApplyPromo"
              data-testid="apply-promo-btn"
              class="rounded-lg bg-slate-800 px-4 py-2 text-xs font-semibold text-indigo-300 hover:bg-slate-700"
            >
              Apply
            </button>
          </div>
          <p
            v-if="cartStore.promoError"
            class="mt-1.5 text-xs text-rose-400"
            data-testid="promo-error"
          >
            {{ cartStore.promoError }}
          </p>
          <p
            v-if="cartStore.appliedDiscount?.valid"
            class="mt-1.5 text-xs text-emerald-400 font-medium"
            data-testid="promo-applied-badge"
          >
            ✓ Code {{ cartStore.appliedDiscount.code }} applied (-${{
              cartStore.discountSavings.toFixed(2)
            }})
          </p>
        </div>

        <div class="space-y-1.5 border-t border-slate-800 pt-3 text-sm">
          <div class="flex justify-between text-slate-400">
            <span>Subtotal</span>
            <span data-testid="cart-subtotal"
              >${{ cartStore.subtotal.toFixed(2) }}</span
            >
          </div>
          <div
            v-if="cartStore.discountSavings > 0"
            class="flex justify-between text-emerald-400"
          >
            <span>Promo Discount</span>
            <span data-testid="cart-discount"
              >-${{ cartStore.discountSavings.toFixed(2) }}</span
            >
          </div>
          <div
            class="flex justify-between text-base font-bold text-white pt-1"
          >
            <span>Total</span>
            <span data-testid="cart-final-total"
              >${{ cartStore.finalTotal.toFixed(2) }}</span
            >
          </div>
        </div>

        <button
          @click="handleCheckout"
          :disabled="cartStore.loading"
          data-testid="checkout-btn"
          class="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/30 transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {{
            cartStore.loading
              ? 'Starting Saga Checkout...'
              : 'Place Order & Run Saga'
          }}
        </button>
      </div>
    </div>
  </div>
</template>
