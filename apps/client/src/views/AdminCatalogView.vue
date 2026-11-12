<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useCatalogStore } from '../stores/catalog.store';
import { useToastStore } from '../stores/toast.store';

const catalogStore = useCatalogStore();
const toastStore = useToastStore();

const title = ref('');
const description = ref('');
const price = ref(129);
const stock = ref(20);
const categoryId = ref('');
const imageUrl = ref('');
const uploading = ref(false);

onMounted(async () => {
  await catalogStore.fetchCategories();
  if (catalogStore.categories.length > 0) {
    categoryId.value = catalogStore.categories[0].id;
  }
});

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  uploading.value = true;
  try {
    const url = await catalogStore.uploadImageToMinio(file);
    imageUrl.value = url;
    toastStore.show('MinIO Upload Complete', `Stored at ${url}`, 'success');
  } catch (err: any) {
    toastStore.show(
      'Upload Failed',
      err?.response?.data?.message || 'MinIO upload error',
      'error',
    );
  } finally {
    uploading.value = false;
  }
}

async function handleCreateProduct() {
  try {
    await catalogStore.createProduct({
      title: title.value,
      description: description.value,
      price: Number(price.value),
      stock: Number(stock.value),
      categoryId: categoryId.value,
      images: imageUrl.value ? [imageUrl.value] : [],
      isActive: true,
    });
    toastStore.show(
      'Product Created',
      'Redis catalog cache invalidated and product published.',
      'success',
    );
    title.value = '';
    description.value = '';
    imageUrl.value = '';
  } catch (err: any) {
    toastStore.show(
      'Creation Error',
      err?.response?.data?.message || 'Failed to create product',
      'error',
    );
  }
}
</script>

<template>
  <div class="max-w-xl mx-auto rounded-2xl border border-slate-800 bg-slate-900/80 p-8 space-y-6">
    <div>
      <h1 class="text-2xl font-extrabold text-white">
        Admin Product &amp; MinIO S3 Studio
      </h1>
      <p class="mt-1 text-xs text-slate-400">
        Streams images directly to MinIO (`products-media`) and invalidates
        Redis `catalog:products:*` keys.
      </p>
    </div>

    <form @submit.prevent="handleCreateProduct" class="space-y-4">
      <div>
        <label class="block text-xs font-medium text-slate-300 mb-1"
          >Product Title</label
        >
        <input
          v-model="title"
          required
          class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm text-white"
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
          class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm text-white"
        ></textarea>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1"
            >Price ($)</label
          >
          <input
            v-model="price"
            type="number"
            step="0.01"
            required
            class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm text-white"
          />
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1"
            >Initial Stock</label
          >
          <input
            v-model="stock"
            type="number"
            required
            class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm text-white"
          />
        </div>
      </div>

      <div>
        <label class="block text-xs font-medium text-slate-300 mb-1"
          >Category</label
        >
        <select
          v-model="categoryId"
          class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm text-white"
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

      <div>
        <label class="block text-xs font-medium text-slate-300 mb-1"
          >Upload Image to MinIO (`products-media`)</label
        >
        <input
          type="file"
          accept="image/*"
          @change="onFileSelected"
          class="w-full text-xs text-slate-400"
        />
        <p v-if="uploading" class="mt-1 text-xs text-indigo-400">
          Streaming to MinIO S3...
        </p>
        <p v-if="imageUrl" class="mt-1 text-xs text-emerald-400 truncate">
          Uploaded: {{ imageUrl }}
        </p>
      </div>

      <button
        type="submit"
        class="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500"
      >
        Publish Product
      </button>
    </form>
  </div>
</template>
