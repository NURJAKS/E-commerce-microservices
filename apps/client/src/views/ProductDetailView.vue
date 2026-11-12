<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ProductDto } from '@shop/contracts';
import { useCatalogStore } from '../stores/catalog.store';
import { useCartStore } from '../stores/cart.store';
import { useAuthStore } from '../stores/auth.store';

const route = useRoute();
const router = useRouter();
const catalogStore = useCatalogStore();
const cartStore = useCartStore();
const authStore = useAuthStore();

const product = ref<ProductDto | null>(null);
const activeImage = ref<string>('');
const loading = ref(true);

onMounted(async () => {
  try {
    const id = String(route.params.id);
    const data = await catalogStore.getProductById(id);
    product.value = data;
    activeImage.value = data.images?.[0] || '';
  } finally {
    loading.value = false;
  }
});

async function handleAddToCart() {
  if (!product.value) return;
  if (!authStore.isAuthenticated) {
    router.push('/login');
    return;
  }
  await cartStore.addItem(product.value, 1);
  cartStore.isOpen = true;
}
</script>

<template>
  <div v-if="loading" class="py-16 text-center text-slate-400">
    Loading product details...
  </div>

  <div
    v-else-if="product"
    class="grid grid-cols-1 gap-8 lg:grid-cols-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-8"
  >
    <!-- Image Gallery (MinIO S3 / Product Media) -->
    <div class="space-y-4">
      <div class="aspect-[16/11] overflow-hidden rounded-xl bg-slate-950 border border-slate-800">
        <img
          :src="
            activeImage ||
            'https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=800&q=80'
          "
          :alt="product.title"
          class="h-full w-full object-cover"
        />
      </div>
      <div v-if="product.images.length > 1" class="flex gap-3">
        <button
          v-for="(img, idx) in product.images"
          :key="idx"
          @click="activeImage = img"
          class="h-16 w-20 overflow-hidden rounded-lg border-2 transition"
          :class="
            activeImage === img ? 'border-indigo-500' : 'border-transparent opacity-70'
          "
        >
          <img :src="img" class="h-full w-full object-cover" />
        </button>
      </div>
    </div>

    <!-- Product Info -->
    <div class="flex flex-col justify-between space-y-6">
      <div class="space-y-4">
        <router-link
          to="/"
          class="inline-flex items-center text-xs font-medium text-indigo-400 hover:text-indigo-300"
        >
          ← Back to Catalog
        </router-link>
        <div class="flex items-center gap-2">
          <span
            v-if="product.category"
            class="rounded-lg bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-400"
          >
            {{ product.category.name }}
          </span>
          <span
            class="rounded-lg px-3 py-1 text-xs font-semibold"
            :class="
              product.stock > 0
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'bg-rose-500/10 text-rose-400'
            "
          >
            {{ product.stock }} units available
          </span>
        </div>

        <h1 class="text-2xl font-extrabold text-white sm:text-3xl">
          {{ product.title }}
        </h1>
        <p class="text-sm text-slate-300 leading-relaxed">
          {{ product.description }}
        </p>
      </div>

      <div class="border-t border-slate-800 pt-6 flex items-center justify-between">
        <div>
          <span class="text-xs text-slate-400 block">Unit Price</span>
          <span class="text-3xl font-black text-white">
            ${{ Number(product.price).toFixed(2) }}
          </span>
        </div>

        <button
          @click="handleAddToCart"
          :disabled="product.stock <= 0"
          data-testid="detail-add-to-cart-btn"
          class="rounded-xl bg-indigo-600 px-8 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/30 transition hover:bg-indigo-500 disabled:opacity-40"
        >
          Add to Redis Cart
        </button>
      </div>
    </div>
  </div>
</template>
