import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  CategoryDto,
  CreateDiscountDto,
  CreateProductDto,
  DiscountDto,
  PaginatedProductsResponse,
  PopularSearchDto,
  PresignedUploadResponse,
  ProductDto,
  ProductReviewsResponse,
  ProductSuggestionDto,
  ReviewDto,
  UpdateDiscountDto,
  UpdateProductDto,
} from '@shop/contracts';
import { http } from '../api/http';

export const useCatalogStore = defineStore('catalog', () => {
  const categories = ref<CategoryDto[]>([]);
  const products = ref<ProductDto[]>([]);
  const discounts = ref<DiscountDto[]>([]);
  const popularSearches = ref<PopularSearchDto[]>([]);
  const recentlyViewed = ref<ProductDto[]>([]);
  const suggestions = ref<ProductSuggestionDto[]>([]);
  const selectedCategoryId = ref<string>('');
  const searchQuery = ref<string>('');
  const minPrice = ref<string>('');
  const maxPrice = ref<string>('');
  const inStockOnly = ref<boolean>(false);
  const sortBy = ref<'relevance' | 'newest' | 'price_asc' | 'price_desc'>(
    'newest',
  );
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

  async function fetchPopularSearches() {
    try {
      const { data } = await http.get<PopularSearchDto[]>(
        '/catalog/search/popular',
      );
      popularSearches.value = data;
    } catch {
      popularSearches.value = [];
    }
  }

  async function fetchRecentlyViewed() {
    try {
      const { data } = await http.get<ProductDto[]>(
        '/catalog/products/recently-viewed',
      );
      recentlyViewed.value = data;
    } catch {
      recentlyViewed.value = [];
    }
  }

  async function recordProductView(productId: string) {
    try {
      await http.post(`/catalog/products/${productId}/view`);
    } catch {
      // Non-fatal analytics write
    }
  }

  async function fetchAutocomplete(query: string) {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      suggestions.value = [];
      return;
    }
    try {
      const { data } = await http.get<ProductSuggestionDto[]>(
        '/catalog/products/autocomplete',
        { params: { q: trimmed, limit: 6 } },
      );
      suggestions.value = data;
    } catch {
      suggestions.value = [];
    }
  }

  async function fetchProducts() {
    loading.value = true;
    try {
      const params: Record<string, any> = {
        page: page.value,
        limit: limit.value,
        sortBy: sortBy.value,
      };
      if (selectedCategoryId.value) {
        params.categoryId = selectedCategoryId.value;
      }
      if (searchQuery.value.trim()) {
        params.search = searchQuery.value.trim();
      }
      if (minPrice.value !== '' && !Number.isNaN(Number(minPrice.value))) {
        params.minPrice = Number(minPrice.value);
      }
      if (maxPrice.value !== '' && !Number.isNaN(Number(maxPrice.value))) {
        params.maxPrice = Number(maxPrice.value);
      }
      if (inStockOnly.value) {
        params.inStockOnly = true;
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

  async function fetchProductReviews(
    productId: string,
  ): Promise<ProductReviewsResponse> {
    const { data } = await http.get<ProductReviewsResponse>(
      `/catalog/products/${productId}/reviews`,
    );
    return data;
  }

  async function createProductReview(
    productId: string,
    payload: { rating: number; comment: string },
  ): Promise<ReviewDto> {
    const { data } = await http.post<ReviewDto>(
      `/catalog/products/${productId}/reviews`,
      payload,
    );
    return data;
  }

  async function checkStockAlert(
    productId: string,
    email?: string,
  ): Promise<{ subscribed: boolean }> {
    const { data } = await http.get<{ subscribed: boolean }>(
      `/catalog/products/${productId}/stock-alert`,
      { params: email ? { email } : undefined },
    );
    return data;
  }

  async function subscribeStockAlert(
    productId: string,
    email?: string,
  ): Promise<{ subscribed: boolean; productId: string; email: string }> {
    const { data } = await http.post<{
      subscribed: boolean;
      productId: string;
      email: string;
    }>(`/catalog/products/${productId}/stock-alert`, {
      ...(email ? { email } : {}),
    });
    return data;
  }

  function selectCategory(categoryId: string) {
    selectedCategoryId.value = categoryId;
    page.value = 1;
    fetchProducts();
  }

  function setSearch(query: string) {
    searchQuery.value = query;
    if (query.trim() && sortBy.value === 'newest') {
      sortBy.value = 'relevance';
    } else if (!query.trim() && sortBy.value === 'relevance') {
      sortBy.value = 'newest';
    }
    page.value = 1;
    fetchProducts().then(() => {
      if (query.trim()) {
        fetchPopularSearches();
      }
    });
  }

  function applyFilters() {
    page.value = 1;
    fetchProducts();
  }

  function resetFilters() {
    selectedCategoryId.value = '';
    searchQuery.value = '';
    minPrice.value = '';
    maxPrice.value = '';
    inStockOnly.value = false;
    sortBy.value = 'newest';
    suggestions.value = [];
    page.value = 1;
    fetchProducts();
  }

  function setPage(nextPage: number) {
    page.value = nextPage;
    fetchProducts();
  }

  /**
   * Direct-to-MinIO Presigned PUT Upload:
   * 1. Requests a 60s SigV4 presigned PUT URL from API Gateway.
   * 2. Streams raw file bytes directly to MinIO (bypassing API Gateway memory/network).
   * 3. Returns object `key` (to persist in catalog-service) and `publicUrl` (for immediate preview).
   */
  async function uploadImageViaPresignedUrl(
    file: File,
    onStage?: (stage: 'signing' | 'uploading' | 'done') => void,
  ): Promise<{ key: string; publicUrl: string }> {
    onStage?.('signing');
    const { data: presigned } = await http.post<PresignedUploadResponse>(
      '/catalog/upload/presign',
      {
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      },
    );

    onStage?.('uploading');
    const putResponse = await fetch(presigned.uploadUrl, {
      method: 'PUT',
      headers: presigned.requiredHeaders,
      body: file,
    });

    if (!putResponse.ok) {
      throw new Error(
        `Direct MinIO PUT failed with HTTP ${putResponse.status}`,
      );
    }

    onStage?.('done');
    return {
      key: presigned.key,
      publicUrl: presigned.publicUrl,
    };
  }

  async function createProduct(dto: CreateProductDto): Promise<ProductDto> {
    const { data } = await http.post<ProductDto>('/catalog/products', dto);
    await fetchProducts();
    return data;
  }

  async function updateProduct(
    id: string,
    dto: UpdateProductDto,
  ): Promise<ProductDto> {
    const { data } = await http.patch<ProductDto>(
      `/catalog/products/${id}`,
      dto,
    );
    await fetchProducts();
    return data;
  }

  async function deleteProduct(id: string): Promise<void> {
    await http.delete(`/catalog/products/${id}`);
    await fetchProducts();
  }

  async function createDiscount(dto: CreateDiscountDto): Promise<DiscountDto> {
    const { data } = await http.post<DiscountDto>('/catalog/discounts', dto);
    await fetchDiscounts();
    return data;
  }

  async function updateDiscount(
    id: string,
    dto: UpdateDiscountDto,
  ): Promise<DiscountDto> {
    const { data } = await http.patch<DiscountDto>(
      `/catalog/discounts/${id}`,
      dto,
    );
    await fetchDiscounts();
    return data;
  }

  async function deleteDiscount(id: string): Promise<void> {
    await http.delete(`/catalog/discounts/${id}`);
    await fetchDiscounts();
  }

  return {
    categories,
    products,
    discounts,
    popularSearches,
    recentlyViewed,
    suggestions,
    selectedCategoryId,
    searchQuery,
    minPrice,
    maxPrice,
    inStockOnly,
    sortBy,
    page,
    limit,
    total,
    totalPages,
    loading,
    fetchCategories,
    fetchDiscounts,
    fetchPopularSearches,
    fetchRecentlyViewed,
    recordProductView,
    fetchAutocomplete,
    fetchProducts,
    getProductById,
    fetchProductReviews,
    createProductReview,
    checkStockAlert,
    subscribeStockAlert,
    selectCategory,
    setSearch,
    applyFilters,
    resetFilters,
    setPage,
    uploadImageViaPresignedUrl,
    createProduct,
    updateProduct,
    deleteProduct,
    createDiscount,
    updateDiscount,
    deleteDiscount,
  };
});
