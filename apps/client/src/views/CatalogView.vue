<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { ProductDto } from '@shop/contracts';
import { useCatalogStore } from '../stores/catalog.store';
import { useCartStore } from '../stores/cart.store';
import { useAuthStore } from '../stores/auth.store';

const catalogStore = useCatalogStore();
const cartStore = useCartStore();
const authStore = useAuthStore();
const router = useRouter();
const localSearch = ref('');

// Hide internal failure-simulation promo code from public storefront marketing badges
const publicDiscounts = computed(() =>
  catalogStore.discounts.filter((d) => d.code !== 'FAIL_PAYMENT'),
);

onMounted(async () => {
  await Promise.all([
    catalogStore.fetchCategories(),
    catalogStore.fetchDiscounts(),
    catalogStore.fetchProducts(),
  ]);
});

function onSearchSubmit() {
  catalogStore.setSearch(localSearch.value);
}

async function handleAddToCart(product: ProductDto) {
  if (!authStore.isAuthenticated) {
    router.push('/login');
    return;
  }
  await cartStore.addItem(product, 1);
  cartStore.isOpen = true;
}
</script>

<template>
  <div class="space-y-8">
    <!-- Hero Banner & Active Promo Badges -->
    <section
      class="relative overflow-hidden rounded-2xl border border-indigo-500/20 bg-gradient-to-br from-slate-900 via-indigo-950/50 to-slate-900 p-8"
    >
      <div class="max-w-2xl space-y-3">
        <span
          class="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-400 border border-indigo-500/20"
        >
          ⚡ Fast Delivery &amp; Secure Checkout
        </span>
        <h1 class="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
          Premium Tech &amp; Accessories
        </h1>
        <p class="text-sm text-slate-300 leading-relaxed">
          Discover our curated collection of premium audio, wearables, and
          workspace accessories. Shop with confidence.
        </p>

        <!-- Promo Code Badges -->
        <div
          v-if="publicDiscounts.length > 0"
          class="pt-2 flex flex-wrap items-center gap-2"
        >
          <span class="text-xs font-medium text-slate-400">Active Promos:</span>
          <span
            v-for="d in publicDiscounts"
            :key="d.id"
            class="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-300"
          >
            <code>{{ d.code }}</code>
            <span v-if="d.percentage > 0">(-{{ d.percentage }}%)</span>
            <span v-else-if="d.fixedAmount > 0">(-${{ d.fixedAmount }})</span>
          </span>
        </div>
      </div>
    </section>

    <!-- Search & Category Filter Bar -->
    <section
      class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div class="flex flex-wrap gap-2">
        <button
          @click="catalogStore.selectCategory('')"
          class="rounded-xl px-4 py-2 text-xs font-semibold transition"
          :class="
            catalogStore.selectedCategoryId === ''
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
              : 'bg-slate-900 text-slate-300 border border-slate-800 hover:bg-slate-800'
          "
        >
          All Categories
        </button>
        <button
          v-for="cat in catalogStore.categories"
          :key="cat.id"
          @click="catalogStore.selectCategory(cat.id)"
          class="rounded-xl px-4 py-2 text-xs font-semibold transition"
          :class="
            catalogStore.selectedCategoryId === cat.id
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
              : 'bg-slate-900 text-slate-300 border border-slate-800 hover:bg-slate-800'
          "
        >
          {{ cat.name }}
        </button>
      </div>

      <form @submit.prevent="onSearchSubmit" class="flex gap-2">
        <input
          v-model="localSearch"
          type="text"
          placeholder="Search products..."
          data-testid="catalog-search-input"
          class="w-full sm:w-64 rounded-xl border border-slate-800 bg-slate-900 px-4 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
        />
        <button
          type="submit"
          class="rounded-xl bg-slate-800 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700"
        >
          Search
        </button>
      </form>
    </section>

    <!-- Product Grid -->
    <section>
      <div
        v-if="catalogStore.loading"
        class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"
      >
        <div
          v-for="n in 6"
          :key="n"
          class="h-80 animate-pulse rounded-2xl border border-slate-800 bg-slate-900/50"
        ></div>
      </div>

      <div
        v-else-if="catalogStore.products.length === 0"
        class="rounded-2xl border border-slate-800 bg-slate-900/40 p-12 text-center text-slate-400"
      >
        No products found matching your filter criteria.
      </div>

      <div
        v-else
        class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"
      >
        <article
          v-for="product in catalogStore.products"
          :key="product.id"
          data-testid="product-card"
          class="group flex flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 transition hover:border-indigo-500/40 hover:shadow-xl hover:shadow-indigo-950/20"
        >
          <router-link
            :to="`/products/${product.id}`"
            class="relative aspect-[16/10] overflow-hidden bg-slate-950"
          >
            <img
              :src="
                product.images?.[0] ||
                'https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=800&q=80'
              "
              :alt="product.title"
              class="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            />
            <span
              v-if="product.category"
              class="absolute left-3 top-3 rounded-lg bg-slate-950/80 px-2.5 py-1 text-[11px] font-medium text-indigo-300 backdrop-blur-sm"
            >
              {{ product.category.name }}
            </span>
            <span
              class="absolute right-3 top-3 rounded-lg px-2.5 py-1 text-[11px] font-semibold backdrop-blur-sm"
              :class="
                product.stock > 0
                  ? 'bg-emerald-950/80 text-emerald-300'
                  : 'bg-rose-950/80 text-rose-300'
              "
            >
              {{ product.stock > 0 ? `${product.stock} in stock` : 'Out of stock' }}
            </span>
          </router-link>

          <div class="flex flex-1 flex-col justify-between p-5 space-y-4">
            <div>
              <router-link
                :to="`/products/${product.id}`"
                class="text-base font-bold text-white hover:text-indigo-400 transition line-clamp-1"
              >
                {{ product.title }}
              </router-link>
              <p class="mt-1.5 text-xs text-slate-400 line-clamp-2">
                {{ product.description }}
              </p>
            </div>

            <div class="flex items-center justify-between pt-2 border-t border-slate-800/80">
              <span
                class="text-lg font-extrabold text-white"
                data-testid="product-price"
              >
                ${{ Number(product.price).toFixed(2) }}
              </span>
              <button
                @click="handleAddToCart(product)"
                :disabled="product.stock <= 0"
                data-testid="add-to-cart-btn"
                class="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
              >
                Add to Cart
              </button>
            </div>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
