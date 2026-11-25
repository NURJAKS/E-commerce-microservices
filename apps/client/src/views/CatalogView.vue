<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { ProductDto } from '@shop/contracts';
import { useCatalogStore } from '../stores/catalog.store';
import { useCartStore } from '../stores/cart.store';
import { useAuthStore } from '../stores/auth.store';
import { useToastStore } from '../stores/toast.store';

const catalogStore = useCatalogStore();
const cartStore = useCartStore();
const authStore = useAuthStore();
const toastStore = useToastStore();
const router = useRouter();

const localSearch = ref('');
const showSuggestions = ref(false);
const alertedProductIds = ref<Set<string>>(new Set());
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// Hide internal failure-simulation promo code from public storefront marketing badges
const publicDiscounts = computed(() =>
  catalogStore.discounts.filter((d) => d.code !== 'FAIL_PAYMENT'),
);

const hasActiveFilters = computed(() =>
  Boolean(
    catalogStore.selectedCategoryId ||
      catalogStore.searchQuery ||
      catalogStore.minPrice !== '' ||
      catalogStore.maxPrice !== '' ||
      catalogStore.inStockOnly,
  ),
);

onMounted(async () => {
  localSearch.value = catalogStore.searchQuery;
  await Promise.all([
    catalogStore.fetchCategories(),
    catalogStore.fetchDiscounts(),
    catalogStore.fetchProducts(),
    catalogStore.fetchPopularSearches(),
    catalogStore.fetchRecentlyViewed(),
  ]);
});

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

function onSearchInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  const value = localSearch.value.trim();
  if (value.length < 2) {
    catalogStore.suggestions = [];
    showSuggestions.value = false;
    return;
  }
  debounceTimer = setTimeout(async () => {
    await catalogStore.fetchAutocomplete(value);
    showSuggestions.value = catalogStore.suggestions.length > 0;
  }, 200);
}

function onSearchSubmit() {
  showSuggestions.value = false;
  catalogStore.setSearch(localSearch.value);
}

function selectPopularTerm(term: string) {
  localSearch.value = term;
  showSuggestions.value = false;
  catalogStore.setSearch(term);
}

function openSuggestion(productId: string) {
  showSuggestions.value = false;
  router.push(`/products/${productId}`);
}

function handleResetFilters() {
  localSearch.value = '';
  showSuggestions.value = false;
  catalogStore.resetFilters();
}

function closeSuggestionsDelayed() {
  setTimeout(() => {
    showSuggestions.value = false;
  }, 160);
}

async function handleAddToCart(product: ProductDto) {
  if (!authStore.isAuthenticated) {
    router.push('/login');
    return;
  }
  await cartStore.addItem(product, 1);
  cartStore.isOpen = true;
}

async function handleNotifyStock(product: ProductDto) {
  if (!authStore.isAuthenticated) {
    router.push(`/products/${product.id}`);
    return;
  }
  try {
    await catalogStore.subscribeStockAlert(product.id);
    alertedProductIds.value = new Set([
      ...alertedProductIds.value,
      product.id,
    ]);
    toastStore.show(
      'Back-in-Stock Alert Set',
      `We will email & notify you when "${product.title}" is restocked.`,
      'success',
    );
  } catch (err: any) {
    toastStore.show(
      'Alert Error',
      err?.response?.data?.message || 'Could not subscribe to restock alert',
      'error',
    );
  }
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
          Typo-tolerant PostgreSQL full-text &amp; trigram search, real-time
          filters, and Redis-powered trending queries.
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

    <!-- Smart Search (with Autocomplete & Popular Searches) + Filters -->
    <section
      class="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 space-y-4"
    >
      <div
        class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
      >
        <!-- Category Pills -->
        <div class="flex flex-wrap gap-2">
          <button
            @click="catalogStore.selectCategory('')"
            class="rounded-xl px-4 py-2 text-xs font-semibold transition"
            :class="
              catalogStore.selectedCategoryId === ''
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
                : 'bg-slate-950 text-slate-300 border border-slate-800 hover:bg-slate-800'
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
                : 'bg-slate-950 text-slate-300 border border-slate-800 hover:bg-slate-800'
            "
          >
            {{ cat.name }}
          </button>
        </div>

        <!-- Typo-tolerant Search with Autocomplete -->
        <form
          @submit.prevent="onSearchSubmit"
          class="relative flex w-full lg:w-96 gap-2"
        >
          <div class="relative flex-1">
            <input
              v-model="localSearch"
              @input="onSearchInput"
              @focus="showSuggestions = catalogStore.suggestions.length > 0"
              @blur="closeSuggestionsDelayed"
              type="text"
              placeholder='Search (try typos like "keybord" or "headfones")...'
              data-testid="catalog-search-input"
              class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />

            <!-- Autocomplete Dropdown -->
            <div
              v-if="showSuggestions && catalogStore.suggestions.length > 0"
              class="absolute left-0 right-0 top-full z-30 mt-1.5 overflow-hidden rounded-xl border border-slate-700 bg-slate-950 shadow-2xl"
            >
              <button
                v-for="item in catalogStore.suggestions"
                :key="item.id"
                type="button"
                @mousedown.prevent="openSuggestion(item.id)"
                class="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-slate-900 transition border-b border-slate-800/70 last:border-b-0"
              >
                <div class="flex items-center gap-3 min-w-0">
                  <img
                    v-if="item.image"
                    :src="item.image"
                    :alt="item.title"
                    class="h-9 w-9 shrink-0 rounded-lg object-cover border border-slate-800"
                  />
                  <div class="min-w-0">
                    <div class="truncate text-xs font-bold text-white">
                      {{ item.title }}
                    </div>
                    <div class="text-[11px] text-slate-400">
                      {{ item.categoryName || 'Catalog' }} ·
                      {{ item.stock > 0 ? `${item.stock} in stock` : 'Out of stock' }}
                    </div>
                  </div>
                </div>
                <span class="shrink-0 text-xs font-extrabold text-indigo-400">
                  ${{ item.price.toFixed(2) }}
                </span>
              </button>
            </div>
          </div>

          <button
            type="submit"
            class="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition"
          >
            Search
          </button>
        </form>
      </div>

      <!-- Price Range, In-Stock & Sort Controls -->
      <div
        class="flex flex-wrap items-center gap-3 border-t border-slate-800 pt-4 text-xs"
      >
        <div class="flex items-center gap-1.5">
          <span class="text-slate-400">Price:</span>
          <input
            v-model="catalogStore.minPrice"
            @change="catalogStore.applyFilters()"
            type="number"
            min="0"
            placeholder="Min $"
            class="w-24 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-white placeholder-slate-500"
          />
          <span class="text-slate-500">–</span>
          <input
            v-model="catalogStore.maxPrice"
            @change="catalogStore.applyFilters()"
            type="number"
            min="0"
            placeholder="Max $"
            class="w-24 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-white placeholder-slate-500"
          />
        </div>

        <label
          class="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-slate-300"
        >
          <input
            v-model="catalogStore.inStockOnly"
            @change="catalogStore.applyFilters()"
            type="checkbox"
            class="rounded border-slate-600 bg-slate-900 text-indigo-600"
          />
          <span>In stock only</span>
        </label>

        <div class="flex items-center gap-1.5">
          <span class="text-slate-400">Sort:</span>
          <select
            v-model="catalogStore.sortBy"
            @change="catalogStore.applyFilters()"
            class="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-white"
          >
            <option v-if="catalogStore.searchQuery" value="relevance">
              Best Match (FTS + Trigram)
            </option>
            <option value="newest">Newest</option>
            <option value="price_asc">Price: Low → High</option>
            <option value="price_desc">Price: High → Low</option>
          </select>
        </div>

        <button
          v-if="hasActiveFilters"
          @click="handleResetFilters"
          class="ml-auto rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800"
        >
          Clear Filters
        </button>
      </div>

      <!-- Popular Searches (Redis Sorted Set ZREVRANGE) -->
      <div
        v-if="catalogStore.popularSearches.length > 0"
        class="flex flex-wrap items-center gap-2 border-t border-slate-800/80 pt-3"
      >
        <span class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Popular Searches:
        </span>
        <button
          v-for="item in catalogStore.popularSearches"
          :key="item.term"
          @click="selectPopularTerm(item.term)"
          class="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 hover:bg-indigo-500/20 transition"
        >
          {{ item.term }}
          <span class="ml-1 text-[10px] opacity-70">({{ item.count }})</span>
        </button>
      </div>
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
              <div class="flex items-center justify-between gap-2">
                <router-link
                  :to="`/products/${product.id}`"
                  class="text-base font-bold text-white hover:text-indigo-400 transition line-clamp-1"
                >
                  {{ product.title }}
                </router-link>
                <span
                  v-if="(product.reviewsCount || 0) > 0"
                  class="shrink-0 inline-flex items-center gap-1 rounded-md bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 text-[11px] font-bold text-amber-300"
                >
                  ★ {{ Number(product.avgRating || 0).toFixed(1) }}
                  <span class="text-[10px] text-amber-400/80"
                    >({{ product.reviewsCount }})</span
                  >
                </span>
              </div>
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
                v-if="product.stock > 0"
                @click="handleAddToCart(product)"
                data-testid="add-to-cart-btn"
                class="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500"
              >
                Add to Cart
              </button>
              <button
                v-else
                @click="handleNotifyStock(product)"
                :disabled="alertedProductIds.has(product.id)"
                data-testid="notify-stock-btn"
                class="rounded-xl border border-amber-500/40 bg-amber-500/15 px-3.5 py-2 text-xs font-semibold text-amber-300 transition hover:bg-amber-500/25 disabled:opacity-60"
              >
                {{
                  alertedProductIds.has(product.id)
                    ? '✓ Alert Set'
                    : '🔔 Notify Me'
                }}
              </button>
            </div>
          </div>
        </article>
      </div>
    </section>

    <!-- Recently Viewed (Redis Sorted Set ZADD / ZREVRANGE) -->
    <section
      v-if="catalogStore.recentlyViewed.length > 0"
      class="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 space-y-4"
    >
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-bold uppercase tracking-wider text-slate-300">
          Recently Viewed
        </h2>
        <span class="text-[11px] font-mono text-slate-500">
          Redis Sorted Set (ZREVRANGE)
        </span>
      </div>

      <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <router-link
          v-for="item in catalogStore.recentlyViewed"
          :key="item.id"
          :to="`/products/${item.id}`"
          class="group rounded-xl border border-slate-800 bg-slate-950/70 p-3 hover:border-indigo-500/40 transition space-y-2"
        >
          <img
            :src="
              item.images?.[0] ||
              'https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=400&q=80'
            "
            :alt="item.title"
            class="aspect-[4/3] w-full rounded-lg object-cover"
          />
          <div class="truncate text-xs font-semibold text-white group-hover:text-indigo-300">
            {{ item.title }}
          </div>
          <div class="text-xs font-bold text-indigo-400">
            ${{ Number(item.price).toFixed(2) }}
          </div>
        </router-link>
      </div>
    </section>
  </div>
</template>
