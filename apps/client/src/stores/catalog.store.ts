import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  CategoryDto,
  CreateProductDto,
  DiscountDto,
  PaginatedProductsResponse,
  ProductDto,
} from '@shop/contracts';
import { http } from '../api/http';

export const useCatalogStore = defineStore('catalog', () => {
  const categories = ref<CategoryDto[]>([]);
  const products = ref<ProductDto[]>([]);
  const discounts = ref<DiscountDto[]>([]);
  const selectedCategoryId = ref<string>('');
  const searchQuery = ref<string>('');
  const page = ref<number>(1);
  const limit = ref<number>(12);
  const total = ref<number>(0);
  const totalPages = ref<number>(1);
  const loading = ref<boolean>(false);

  async function fetchCategories() {
    const { data } = await http.get<CategoryDto[]>('/catalog/categories');
    categories.value = data;
  }

  async function fetchDiscounts() {
    const { data } = await http.get<DiscountDto[]>('/catalog/discounts');
    discounts.value = data;
  }

  async function fetchProducts() {
    loading.value = true;
    try {
      const params: Record<string, any> = {
        page: page.value,
        limit: limit.value,
      };
      if (selectedCategoryId.value) {
        params.categoryId = selectedCategoryId.value;
      }
      if (searchQuery.value.trim()) {
        params.search = searchQuery.value.trim();
      }

      const { data } = await http.get<PaginatedProductsResponse>(
        '/catalog/products',
        { params },
      );
      products.value = data.items;
      total.value = data.total;
      totalPages.value = data.totalPages;
    } finally {
      loading.value = false;
    }
  }

  async function getProductById(id: string): Promise<ProductDto> {
    const { data } = await http.get<ProductDto>(`/catalog/products/${id}`);
    return data;
  }

  function selectCategory(categoryId: string) {
    selectedCategoryId.value = categoryId;
    page.value = 1;
    fetchProducts();
  }

  function setSearch(query: string) {
    searchQuery.value = query;
    page.value = 1;
    fetchProducts();
  }

  function setPage(nextPage: number) {
    page.value = nextPage;
    fetchProducts();
  }

  async function uploadImageToMinio(file: File): Promise<string> {
    const formData = new FormData();
    formData.append('file', file);
    const { data } = await http.post<{ url: string; key: string }>(
      '/catalog/upload',
      formData,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
      },
    );
    return data.url;
  }

  async function createProduct(dto: CreateProductDto): Promise<ProductDto> {
    const { data } = await http.post<ProductDto>('/catalog/products', dto);
    await fetchProducts();
    return data;
  }

  return {
    categories,
    products,
    discounts,
    selectedCategoryId,
    searchQuery,
    page,
    limit,
    total,
    totalPages,
    loading,
    fetchCategories,
    fetchDiscounts,
    fetchProducts,
    getProductById,
    selectCategory,
    setSearch,
    setPage,
    uploadImageToMinio,
    createProduct,
  };
});
