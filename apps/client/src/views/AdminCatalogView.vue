<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { DiscountDto, ProductDto } from '@shop/contracts';
import { useCatalogStore } from '../stores/catalog.store';
import { useToastStore } from '../stores/toast.store';

const catalogStore = useCatalogStore();
const toastStore = useToastStore();

const activeTab = ref<'products' | 'discounts'>('products');

// Product Create/Edit form state
const editingProductId = ref<string | null>(null);
const title = ref('');
const description = ref('');
const price = ref(129);
const stock = ref(20);
const categoryId = ref('');
const isActive = ref(true);
const imageKey = ref('');
const imagePreviewUrl = ref('');
const uploadStage = ref<'idle' | 'signing' | 'uploading' | 'done'>('idle');
const isDragging = ref(false);

// Discount Create form state
const promoCode = ref('');
const promoPercentage = ref(15);
const promoFixedAmount = ref(0);
const promoValidFrom = ref(new Date().toISOString().slice(0, 16));
const promoValidUntil = ref(
  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
);
const promoMaxUses = ref<number | ''>(100);
const promoMaxUsesPerUser = ref<number | ''>(1);

onMounted(async () => {
  await Promise.all([
    catalogStore.fetchCategories(),
    catalogStore.fetchProducts(),
    catalogStore.fetchDiscounts(),
  ]);
  if (catalogStore.categories.length > 0) {
    categoryId.value = catalogStore.categories[0].id;
  }
});

async function handleFileUpload(file: File) {
  if (!file.type.startsWith('image/')) {
    toastStore.show('Invalid File', 'Only image files are allowed.', 'error');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    toastStore.show('File Too Large', 'Maximum image size is 10 MB.', 'error');
    return;
  }

  try {
    const result = await catalogStore.uploadImageViaPresignedUrl(
      file,
      (stage) => {
        uploadStage.value = stage;
      },
    );
    imageKey.value = result.key;
    imagePreviewUrl.value = result.publicUrl;
    toastStore.show(
      'Direct MinIO Upload Complete',
      `Uploaded directly via 60s Presigned PUT URL (key: ${result.key})`,
      'success',
    );
  } catch (err: any) {
    uploadStage.value = 'idle';
    toastStore.show(
      'Presigned Upload Failed',
      err?.response?.data?.message || err?.message || 'Direct MinIO PUT error',
      'error',
    );
  }
}

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    await handleFileUpload(file);
    input.value = '';
  }
}

async function onDrop(event: DragEvent) {
  isDragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    await handleFileUpload(file);
  }
}

function resetProductForm() {
  editingProductId.value = null;
  title.value = '';
  description.value = '';
  price.value = 129;
  stock.value = 20;
  isActive.value = true;
  imageKey.value = '';
  imagePreviewUrl.value = '';
  uploadStage.value = 'idle';
  if (catalogStore.categories.length > 0) {
    categoryId.value = catalogStore.categories[0].id;
  }
}

function startEditProduct(product: ProductDto) {
  editingProductId.value = product.id;
  title.value = product.title;
  description.value = product.description;
  price.value = product.price;
  stock.value = product.stock;
  categoryId.value = product.categoryId;
  isActive.value = product.isActive;
  imagePreviewUrl.value = product.images[0] || '';
  imageKey.value = '';
  uploadStage.value = 'idle';
}

async function handleSaveProduct() {
  try {
    const imagesPayload = imageKey.value
      ? [imageKey.value]
      : imagePreviewUrl.value
        ? [imagePreviewUrl.value]
        : [];

    if (editingProductId.value) {
      await catalogStore.updateProduct(editingProductId.value, {
        title: title.value,
        description: description.value,
        price: Number(price.value),
        stock: Number(stock.value),
        categoryId: categoryId.value,
        images: imagesPayload,
        isActive: isActive.value,
      });
      toastStore.show(
        'Product Updated',
        'Changes saved, StockMovement recorded if stock changed, and Redis cache evicted.',
        'success',
      );
    } else {
      await catalogStore.createProduct({
        title: title.value,
        description: description.value,
        price: Number(price.value),
        stock: Number(stock.value),
        categoryId: categoryId.value,
        images: imagesPayload,
        isActive: isActive.value,
      });
      toastStore.show(
        'Product Published',
        'Stored object key in catalog_db and invalidated Redis cache.',
        'success',
      );
    }
    resetProductForm();
  } catch (err: any) {
    toastStore.show(
      'Save Error',
      err?.response?.data?.message || 'Failed to save product',
      'error',
    );
  }
}

async function adjustStock(product: ProductDto, delta: number) {
  const nextStock = Math.max(0, product.stock + delta);
  try {
    await catalogStore.updateProduct(product.id, { stock: nextStock });
    toastStore.show(
      'Inventory Adjusted',
      `${product.title}: stock updated to ${nextStock}`,
      'success',
    );
  } catch (err: any) {
    toastStore.show(
      'Stock Update Failed',
      err?.response?.data?.message || 'Could not update stock',
      'error',
    );
  }
}

async function handleDeleteProduct(product: ProductDto) {
  try {
    await catalogStore.deleteProduct(product.id);
    if (editingProductId.value === product.id) {
      resetProductForm();
    }
    toastStore.show('Product Deleted', `"${product.title}" removed.`, 'info');
  } catch (err: any) {
    toastStore.show(
      'Delete Error',
      err?.response?.data?.message || 'Could not delete product',
      'error',
    );
  }
}

async function handleCreateDiscount() {
  try {
    await catalogStore.createDiscount({
      code: promoCode.value.trim().toUpperCase(),
      percentage: Number(promoPercentage.value || 0),
      fixedAmount: Number(promoFixedAmount.value || 0),
      validFrom: new Date(promoValidFrom.value).toISOString(),
      validUntil: new Date(promoValidUntil.value).toISOString(),
      maxUses: promoMaxUses.value === '' ? null : Number(promoMaxUses.value),
      maxUsesPerUser:
        promoMaxUsesPerUser.value === ''
          ? null
          : Number(promoMaxUsesPerUser.value),
      isActive: true,
    });
    toastStore.show(
      'Promo Code Created',
      `Code "${promoCode.value.trim().toUpperCase()}" is now live.`,
      'success',
    );
    promoCode.value = '';
  } catch (err: any) {
    toastStore.show(
      'Promo Error',
      err?.response?.data?.message || 'Failed to create promo code',
      'error',
    );
  }
}

async function toggleDiscountActive(discount: DiscountDto) {
  try {
    await catalogStore.updateDiscount(discount.id, {
      isActive: !discount.isActive,
    });
    toastStore.show(
      'Promo Updated',
      `${discount.code} is now ${!discount.isActive ? 'active' : 'paused'}.`,
      'info',
    );
  } catch (err: any) {
    toastStore.show(
      'Update Failed',
      err?.response?.data?.message || 'Could not update promo code',
      'error',
    );
  }
}

async function handleDeleteDiscount(discount: DiscountDto) {
  try {
    await catalogStore.deleteDiscount(discount.id);
    toastStore.show('Promo Deleted', `Deleted ${discount.code}.`, 'info');
  } catch (err: any) {
    toastStore.show(
      'Delete Failed',
      err?.response?.data?.message || 'Could not delete promo code',
      'error',
    );
  }
}
</script>

<template>
  <div class="max-w-6xl mx-auto space-y-6">
    <!-- Header & Tab Switcher -->
    <div
      class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-slate-800 bg-slate-900/80 p-6"
    >
      <div>
        <h1 class="text-2xl font-extrabold text-white">
          Admin Studio — Direct MinIO Presigned Uploads &amp; Catalog Control
        </h1>
        <p class="mt-1 text-xs text-slate-400">
          Images upload straight from your browser to MinIO via 60s SigV4
          Presigned PUT URLs (bypassing API Gateway memory); only the object key
          is sent to <code class="text-indigo-300">catalog-service</code>.
        </p>
      </div>

      <div class="flex gap-2">
        <button
          @click="activeTab = 'products'"
          class="rounded-xl px-4 py-2 text-xs font-bold transition"
          :class="
            activeTab === 'products'
              ? 'bg-indigo-600 text-white'
              : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
          "
        >
          Products &amp; Stock ({{ catalogStore.products.length }})
        </button>
        <button
          @click="activeTab = 'discounts'"
          class="rounded-xl px-4 py-2 text-xs font-bold transition"
          :class="
            activeTab === 'discounts'
              ? 'bg-indigo-600 text-white'
              : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
          "
        >
          Promo Codes ({{ catalogStore.discounts.length }})
        </button>
      </div>
    </div>

    <!-- TAB 1: PRODUCTS & INVENTORY -->
    <div
      v-if="activeTab === 'products'"
      class="grid grid-cols-1 gap-6 lg:grid-cols-12"
    >
      <!-- Left: Create / Edit Form -->
      <div
        class="lg:col-span-5 rounded-2xl border border-slate-800 bg-slate-900/80 p-6 space-y-5"
      >
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-bold text-white">
            {{ editingProductId ? 'Edit Product' : 'Create New Product' }}
          </h2>
          <button
            v-if="editingProductId"
            @click="resetProductForm"
            class="text-xs font-semibold text-slate-400 hover:text-white"
          >
            Cancel Edit
          </button>
        </div>

        <form @submit.prevent="handleSaveProduct" class="space-y-4">
          <div>
            <label class="block text-xs font-medium text-slate-300 mb-1"
              >Product Title</label
            >
            <input
              v-model="title"
              required
              class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-white"
            />
          </div>

          <div>
            <label class="block text-xs font-medium text-slate-300 mb-1"
              >Description</label
            >
            <textarea
              v-model="description"
              required
              rows="3"
              class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-white"
            ></textarea>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1"
                >Price ($)</label
              >
              <input
                v-model="price"
                type="number"
                step="0.01"
                min="0.01"
                required
                class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1"
                >Stock</label
              >
              <input
                v-model="stock"
                type="number"
                min="0"
                required
                class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-white"
              />
            </div>
          </div>

          <div>
            <label class="block text-xs font-medium text-slate-300 mb-1"
              >Category</label
            >
            <select
              v-model="categoryId"
              class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-white"
            >
              <option
                v-for="cat in catalogStore.categories"
                :key="cat.id"
                :value="cat.id"
              >
                {{ cat.name }}
              </option>
            </select>
          </div>

          <!-- Drag-and-Drop Direct-to-MinIO Presigned Uploader -->
          <div>
            <label class="block text-xs font-medium text-slate-300 mb-1">
              Product Image (Direct MinIO Presigned PUT — 60s TTL, max 10 MB)
            </label>
            <div
              @dragover.prevent="isDragging = true"
              @dragleave.prevent="isDragging = false"
              @drop.prevent="onDrop"
              class="relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-5 text-center transition"
              :class="
                isDragging
                  ? 'border-indigo-400 bg-indigo-950/30'
                  : 'border-slate-700 bg-slate-950/70 hover:border-slate-500'
              "
            >
              <img
                v-if="imagePreviewUrl"
                :src="imagePreviewUrl"
                alt="Preview"
                class="mb-3 h-28 w-28 rounded-lg object-cover border border-slate-700"
              />
              <p class="text-xs text-slate-300">
                Drag &amp; drop an image here, or
                <label
                  class="cursor-pointer font-bold text-indigo-400 hover:underline"
                >
                  browse
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    class="hidden"
                    @change="onFileSelected"
                  />
                </label>
              </p>
              <p
                v-if="uploadStage === 'signing'"
                class="mt-2 text-xs text-amber-400"
              >
                1/2 Requesting 60s Presigned PUT URL from API Gateway...
              </p>
              <p
                v-else-if="uploadStage === 'uploading'"
                class="mt-2 text-xs text-indigo-400"
              >
                2/2 Streaming bytes directly to MinIO S3 (bypassing Gateway)...
              </p>
              <p
                v-else-if="imageKey"
                class="mt-2 text-[11px] font-mono text-emerald-400 break-all"
              >
                Object key ready: {{ imageKey }}
              </p>
            </div>
          </div>

          <button
            type="submit"
            :disabled="uploadStage === 'signing' || uploadStage === 'uploading'"
            class="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-500 disabled:opacity-50 transition"
          >
            {{ editingProductId ? 'Save Product Changes' : 'Publish Product' }}
          </button>
        </form>
      </div>

      <!-- Right: Live Inventory Table -->
      <div
        class="lg:col-span-7 rounded-2xl border border-slate-800 bg-slate-900/80 p-6 space-y-4"
      >
        <h2 class="text-lg font-bold text-white">Catalog Inventory</h2>
        <div class="space-y-3 max-h-[640px] overflow-y-auto pr-1">
          <div
            v-for="prod in catalogStore.products"
            :key="prod.id"
            class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-slate-800 bg-slate-950/70 p-4"
          >
            <div class="flex items-center gap-3 min-w-0">
              <img
                v-if="prod.images[0]"
                :src="prod.images[0]"
                :alt="prod.title"
                class="h-12 w-12 shrink-0 rounded-lg object-cover border border-slate-800"
              />
              <div class="min-w-0">
                <div class="truncate text-sm font-bold text-white">
                  {{ prod.title }}
                </div>
                <div class="text-xs text-slate-400">
                  ${{ prod.price.toFixed(2) }} ·
                  <span
                    :class="
                      prod.stock === 0 ? 'text-rose-400 font-bold' : 'text-emerald-400'
                    "
                  >
                    Stock: {{ prod.stock }}
                  </span>
                </div>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-1.5 shrink-0">
              <button
                @click="adjustStock(prod, -1)"
                class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs font-mono text-slate-300 hover:bg-slate-800"
              >
                -1
              </button>
              <button
                @click="adjustStock(prod, 5)"
                class="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-2 py-1 text-xs font-mono text-emerald-300 hover:bg-emerald-900/40"
              >
                +5
              </button>
              <button
                @click="startEditProduct(prod)"
                class="rounded-lg border border-indigo-500/30 bg-indigo-950/30 px-2.5 py-1 text-xs font-semibold text-indigo-300 hover:bg-indigo-900/40"
              >
                Edit
              </button>
              <button
                @click="handleDeleteProduct(prod)"
                class="rounded-lg border border-rose-500/30 bg-rose-950/30 px-2.5 py-1 text-xs font-semibold text-rose-300 hover:bg-rose-900/40"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 2: PROMO CODES -->
    <div v-else class="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <div
        class="lg:col-span-5 rounded-2xl border border-slate-800 bg-slate-900/80 p-6 space-y-4"
      >
        <h2 class="text-lg font-bold text-white">Create Promo Code</h2>
        <form @submit.prevent="handleCreateDiscount" class="space-y-3.5">
          <div>
            <label class="block text-xs font-medium text-slate-300 mb-1"
              >Promo Code</label
            >
            <input
              v-model="promoCode"
              required
              placeholder="SUMMER15"
              class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm uppercase text-white"
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1"
                >Percent Off (%)</label
              >
              <input
                v-model="promoPercentage"
                type="number"
                min="0"
                max="100"
                class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1"
                >Fixed Off ($)</label
              >
              <input
                v-model="promoFixedAmount"
                type="number"
                step="0.01"
                min="0"
                class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-white"
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1"
                >Max Total Uses</label
              >
              <input
                v-model="promoMaxUses"
                type="number"
                min="1"
                placeholder="Unlimited"
                class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1"
                >Max Uses / User</label
              >
              <input
                v-model="promoMaxUsesPerUser"
                type="number"
                min="1"
                placeholder="Unlimited"
                class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-white"
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1"
                >Valid From</label
              >
              <input
                v-model="promoValidFrom"
                type="datetime-local"
                required
                class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1"
                >Valid Until</label
              >
              <input
                v-model="promoValidUntil"
                type="datetime-local"
                required
                class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
              />
            </div>
          </div>

          <button
            type="submit"
            class="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-500 transition"
          >
            Create Promo Code
          </button>
        </form>
      </div>

      <div
        class="lg:col-span-7 rounded-2xl border border-slate-800 bg-slate-900/80 p-6 space-y-4"
      >
        <h2 class="text-lg font-bold text-white">Active &amp; Scheduled Promos</h2>
        <div class="space-y-3">
          <div
            v-for="d in catalogStore.discounts"
            :key="d.id"
            class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-slate-800 bg-slate-950/70 p-4"
          >
            <div>
              <div class="flex items-center gap-2">
                <span class="font-mono text-sm font-extrabold text-indigo-300">{{
                  d.code
                }}</span>
                <span
                  class="rounded px-2 py-0.5 text-[10px] font-bold"
                  :class="
                    d.isActive
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-slate-800 text-slate-400'
                  "
                >
                  {{ d.isActive ? 'ACTIVE' : 'PAUSED' }}
                </span>
              </div>
              <p class="mt-1 text-xs text-slate-300">
                {{ d.percentage > 0 ? `${d.percentage}% off` : '' }}
                {{ d.percentage > 0 && d.fixedAmount > 0 ? ' + ' : '' }}
                {{ d.fixedAmount > 0 ? `$${d.fixedAmount} off` : '' }}
                · Used: <strong>{{ d.usedCount }}</strong>
                <span v-if="d.maxUses !== null"> / {{ d.maxUses }}</span>
                <span v-if="d.maxUsesPerUser !== null">
                  · Limit {{ d.maxUsesPerUser }}/user
                </span>
              </p>
              <p class="text-[11px] text-slate-500">
                Valid until {{ new Date(d.validUntil).toLocaleDateString() }}
              </p>
            </div>

            <div class="flex items-center gap-2">
              <button
                @click="toggleDiscountActive(d)"
                class="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800"
              >
                {{ d.isActive ? 'Pause' : 'Activate' }}
              </button>
              <button
                @click="handleDeleteDiscount(d)"
                class="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-900/40"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
