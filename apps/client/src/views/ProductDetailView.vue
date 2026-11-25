<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ProductDto, ProductReviewsResponse } from '@shop/contracts';
import { useCatalogStore } from '../stores/catalog.store';
import { useCartStore } from '../stores/cart.store';
import { useAuthStore } from '../stores/auth.store';
import { useToastStore } from '../stores/toast.store';

const route = useRoute();
const router = useRouter();
const catalogStore = useCatalogStore();
const cartStore = useCartStore();
const authStore = useAuthStore();
const toastStore = useToastStore();

const product = ref<ProductDto | null>(null);
const reviewsData = ref<ProductReviewsResponse | null>(null);
const activeImage = ref<string>('');
const loading = ref(true);

const reviewRating = ref(5);
const reviewComment = ref('');
const submittingReview = ref(false);

const alertEmail = ref('');
const stockAlertSubscribed = ref(false);
const subscribingAlert = ref(false);

async function loadProduct(id: string) {
  loading.value = true;
  try {
    const [prodData, revData] = await Promise.all([
      catalogStore.getProductById(id),
      catalogStore.fetchProductReviews(id),
    ]);
    product.value = prodData;
    reviewsData.value = revData;
    activeImage.value = prodData.images?.[0] || '';
    void catalogStore.recordProductView(id);

    if (prodData.stock === 0 && authStore.isAuthenticated) {
      try {
        const res = await catalogStore.checkStockAlert(id);
        stockAlertSubscribed.value = res.subscribed;
      } catch {
        stockAlertSubscribed.value = false;
      }
    } else {
      stockAlertSubscribed.value = false;
    }
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await loadProduct(String(route.params.id));
});

watch(
  () => route.params.id,
  (newId) => {
    if (newId) {
      void loadProduct(String(newId));
    }
  },
);

async function handleAddToCart() {
  if (!product.value) return;
  if (!authStore.isAuthenticated) {
    router.push('/login');
    return;
  }
  await cartStore.addItem(product.value, 1);
  cartStore.isOpen = true;
}

async function handleSubscribeStockAlert() {
  if (!product.value || subscribingAlert.value) return;
  subscribingAlert.value = true;
  try {
    const email = authStore.isAuthenticated
      ? undefined
      : alertEmail.value.trim();
    const res = await catalogStore.subscribeStockAlert(product.value.id, email);
    stockAlertSubscribed.value = res.subscribed;
    toastStore.show(
      'Back-in-Stock Alert Active',
      `We will notify ${res.email} as soon as "${product.value.title}" is back in stock!`,
      'success',
    );
  } catch (err: any) {
    toastStore.show(
      'Subscription Failed',
      err?.response?.data?.message || 'Could not set restock alert',
      'error',
    );
  } finally {
    subscribingAlert.value = false;
  }
}

async function handleSubmitReview() {
  if (!product.value || submittingReview.value) return;
  submittingReview.value = true;
  try {
    await catalogStore.createProductReview(product.value.id, {
      rating: reviewRating.value,
      comment: reviewComment.value.trim(),
    });
    reviewComment.value = '';
    toastStore.show(
      'Verified Review Published',
      'Product rating updated and Redis cache invalidated.',
      'success',
    );
    const [updatedProd, updatedReviews] = await Promise.all([
      catalogStore.getProductById(product.value.id),
      catalogStore.fetchProductReviews(product.value.id),
    ]);
    product.value = updatedProd;
    reviewsData.value = updatedReviews;
  } catch (err: any) {
    toastStore.show(
      'Review Rejected',
      err?.response?.data?.message || 'Could not submit review',
      'error',
    );
  } finally {
    submittingReview.value = false;
  }
}
</script>

<template>
  <div v-if="loading" class="py-16 text-center text-slate-400">
    Loading product details...
  </div>

  <div v-else-if="product" class="space-y-8">
    <!-- Main Product Card -->
    <div
      class="grid grid-cols-1 gap-8 lg:grid-cols-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-8"
    >
      <!-- Image Gallery (MinIO S3 / Product Media) -->
      <div class="space-y-4">
        <div
          class="aspect-[16/11] overflow-hidden rounded-xl bg-slate-950 border border-slate-800"
        >
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
              activeImage === img
                ? 'border-indigo-500'
                : 'border-transparent opacity-70'
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
          <div class="flex flex-wrap items-center gap-2">
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
            <span
              v-if="(product.reviewsCount || 0) > 0"
              class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-bold text-amber-300"
            >
              ★ {{ Number(product.avgRating || 0).toFixed(1) }} ({{
                product.reviewsCount
              }}
              verified)
            </span>
          </div>

          <h1 class="text-2xl font-extrabold text-white sm:text-3xl">
            {{ product.title }}
          </h1>
          <p class="text-sm text-slate-300 leading-relaxed">
            {{ product.description }}
          </p>
        </div>

        <div
          class="border-t border-slate-800 pt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <span class="text-xs text-slate-400 block">Unit Price</span>
            <span class="text-3xl font-black text-white">
              ${{ Number(product.price).toFixed(2) }}
            </span>
          </div>

          <button
            v-if="product.stock > 0"
            @click="handleAddToCart"
            data-testid="detail-add-to-cart-btn"
            class="rounded-xl bg-indigo-600 px-8 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/30 transition hover:bg-indigo-500"
          >
            Add to Redis Cart
          </button>

          <div
            v-else-if="stockAlertSubscribed"
            class="rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-5 py-3 text-xs font-bold text-emerald-300"
          >
            ✓ Back-in-Stock Alert Active (Email &amp; WebSocket)
          </div>

          <form
            v-else
            @submit.prevent="handleSubscribeStockAlert"
            class="flex flex-wrap items-center gap-2"
          >
            <input
              v-if="!authStore.isAuthenticated"
              v-model="alertEmail"
              type="email"
              required
              placeholder="Your email for restock alert"
              class="rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-xs text-white placeholder-slate-500"
            />
            <button
              type="submit"
              :disabled="subscribingAlert"
              data-testid="detail-notify-stock-btn"
              class="rounded-xl border border-amber-500/40 bg-amber-500/20 px-6 py-3 text-xs font-bold text-amber-200 hover:bg-amber-500/30 disabled:opacity-50 transition"
            >
              {{
                subscribingAlert
                  ? 'Subscribing...'
                  : '🔔 Notify When Back in Stock'
              }}
            </button>
          </form>
        </div>
      </div>
    </div>

    <!-- Verified Purchase Reviews Section (Event-Driven Local Projection) -->
    <section
      v-if="reviewsData"
      class="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 space-y-6"
    >
      <div
        class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-slate-800 pb-4"
      >
        <div>
          <h2 class="text-xl font-extrabold text-white">
            Verified Purchase Reviews
          </h2>
          <p class="text-xs text-slate-400">
            Powered by local <code class="text-indigo-300">payment.succeeded</code>
            event projections in <code class="text-indigo-300">catalog_db</code>
            (zero cross-DB joins).
          </p>
        </div>
        <div class="text-right">
          <span class="text-2xl font-black text-amber-300">
            ★ {{ reviewsData.avgRating.toFixed(1) }}
          </span>
          <span class="block text-xs text-slate-400">
            {{ reviewsData.reviewsCount }} review{{
              reviewsData.reviewsCount === 1 ? '' : 's'
            }}
          </span>
        </div>
      </div>

      <!-- Review Submission Form (Only unlocked for verified buyers!) -->
      <div
        v-if="reviewsData.canReview"
        class="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-5 space-y-4"
      >
        <div class="flex items-center justify-between">
          <span class="text-xs font-bold text-emerald-300">
            ✓ Verified Purchase unlocked — share your feedback
          </span>
          <div class="flex items-center gap-1">
            <button
              v-for="star in 5"
              :key="star"
              type="button"
              @click="reviewRating = star"
              class="text-xl transition"
              :class="star <= reviewRating ? 'text-amber-400' : 'text-slate-600'"
            >
              ★
            </button>
          </div>
        </div>

        <form @submit.prevent="handleSubmitReview" class="space-y-3">
          <textarea
            v-model="reviewComment"
            required
            minlength="3"
            rows="3"
            placeholder="What did you like or dislike about this product?"
            class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
          ></textarea>
          <button
            type="submit"
            :disabled="submittingReview"
            data-testid="submit-review-btn"
            class="rounded-xl bg-emerald-600 px-5 py-2 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-50 transition"
          >
            {{ submittingReview ? 'Publishing...' : 'Submit Verified Review' }}
          </button>
        </form>
      </div>

      <div
        v-else-if="reviewsData.hasReviewed"
        class="rounded-xl border border-indigo-500/30 bg-indigo-950/20 px-4 py-3 text-xs text-indigo-300"
      >
        You have already submitted a verified review for this product.
      </div>

      <div
        v-else
        class="rounded-xl border border-slate-800 bg-slate-950/50 px-4 py-3 text-xs text-slate-400"
      >
        {{
          authStore.isAuthenticated
            ? 'Only customers who have purchased this product (status PAID) can leave a Verified Purchase review.'
            : 'Sign in and purchase this item to leave a Verified Purchase review.'
        }}
      </div>

      <!-- Reviews List -->
      <div
        v-if="reviewsData.items.length === 0"
        class="py-6 text-center text-sm text-slate-500"
      >
        No reviews yet. Be the first verified buyer to review this product!
      </div>

      <div v-else class="space-y-3">
        <article
          v-for="rev in reviewsData.items"
          :key="rev.id"
          class="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-2"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="text-sm font-bold text-amber-400">
                {{ '★'.repeat(rev.rating)
                }}<span class="text-slate-700">{{ '★'.repeat(5 - rev.rating) }}</span>
              </span>
              <span class="text-xs font-semibold text-white">{{
                rev.userEmail
              }}</span>
              <span
                class="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold text-emerald-300"
              >
                ✓ Verified Purchase
              </span>
            </div>
            <span class="text-[11px] text-slate-500">
              {{ new Date(rev.createdAt).toLocaleDateString() }}
            </span>
          </div>
          <p class="text-sm text-slate-300 leading-relaxed">
            {{ rev.comment }}
          </p>
        </article>
      </div>
    </section>
  </div>
</template>
