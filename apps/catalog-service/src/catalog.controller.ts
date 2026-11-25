import { Controller, UseFilters, UseInterceptors } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  CATALOG_PATTERNS,
  CreateCategoryDto,
  CreateDiscountDto,
  CreateProductDto,
  CreateReviewDto,
  ProductQueryDto,
  UpdateDiscountDto,
  UpdateProductDto,
} from '@shop/contracts';
import { AllRpcExceptionFilter, LoggingInterceptor } from '@shop/common';
import { CatalogService } from './catalog.service';

@Controller()
@UseFilters(new AllRpcExceptionFilter())
@UseInterceptors(new LoggingInterceptor())
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @MessagePattern(CATALOG_PATTERNS.GET_CATEGORIES)
  getCategories() {
    return this.catalogService.getCategories();
  }

  @MessagePattern(CATALOG_PATTERNS.CREATE_CATEGORY)
  createCategory(@Payload() dto: CreateCategoryDto) {
    return this.catalogService.createCategory(dto);
  }

  @MessagePattern(CATALOG_PATTERNS.GET_PRODUCTS)
  getProducts(@Payload() query: ProductQueryDto) {
    return this.catalogService.getProducts(query);
  }

  @MessagePattern(CATALOG_PATTERNS.GET_PRODUCT_BY_ID)
  getProductById(@Payload() data: { id: string }) {
    return this.catalogService.getProductById(data.id);
  }

  @MessagePattern(CATALOG_PATTERNS.AUTOCOMPLETE_PRODUCTS)
  autocompleteProducts(@Payload() data: { q: string; limit?: number }) {
    return this.catalogService.autocompleteProducts(data.q, data.limit);
  }

  @MessagePattern(CATALOG_PATTERNS.GET_POPULAR_SEARCHES)
  getPopularSearches(@Payload() data: { limit?: number }) {
    return this.catalogService.getPopularSearches(data?.limit);
  }

  @MessagePattern(CATALOG_PATTERNS.RECORD_PRODUCT_VIEW)
  recordProductView(
    @Payload() data: { viewerId: string; productId: string },
  ) {
    return this.catalogService.recordProductView(data.viewerId, data.productId);
  }

  @MessagePattern(CATALOG_PATTERNS.GET_RECENTLY_VIEWED)
  getRecentlyViewed(@Payload() data: { viewerId: string; limit?: number }) {
    return this.catalogService.getRecentlyViewedProducts(
      data.viewerId,
      data.limit,
    );
  }

  @MessagePattern(CATALOG_PATTERNS.GET_PRODUCT_REVIEWS)
  getProductReviews(
    @Payload() data: { productId: string; viewerUserId?: string },
  ) {
    return this.catalogService.getProductReviews(
      data.productId,
      data.viewerUserId,
    );
  }

  @MessagePattern(CATALOG_PATTERNS.CREATE_PRODUCT_REVIEW)
  createProductReview(
    @Payload()
    data: {
      productId: string;
      userId: string;
      userEmail: string;
      dto: CreateReviewDto;
    },
  ) {
    return this.catalogService.createProductReview(
      data.productId,
      data.userId,
      data.userEmail,
      data.dto,
    );
  }

  @MessagePattern(CATALOG_PATTERNS.SUBSCRIBE_STOCK_ALERT)
  subscribeStockAlert(
    @Payload() data: { productId: string; email: string; userId?: string },
  ) {
    return this.catalogService.subscribeStockAlert(
      data.productId,
      data.email,
      data.userId,
    );
  }

  @MessagePattern(CATALOG_PATTERNS.CHECK_STOCK_ALERT)
  checkStockAlert(
    @Payload() data: { productId: string; email?: string; userId?: string },
  ) {
    return this.catalogService.isSubscribedToStockAlert(
      data.productId,
      data.email,
      data.userId,
    );
  }

  @MessagePattern(CATALOG_PATTERNS.CREATE_PRODUCT)
  createProduct(@Payload() dto: CreateProductDto) {
    return this.catalogService.createProduct(dto);
  }

  @MessagePattern(CATALOG_PATTERNS.UPDATE_PRODUCT)
  updateProduct(@Payload() data: { id: string; dto: UpdateProductDto }) {
    return this.catalogService.updateProduct(data.id, data.dto);
  }

  @MessagePattern(CATALOG_PATTERNS.DELETE_PRODUCT)
  deleteProduct(@Payload() data: { id: string }) {
    return this.catalogService.deleteProduct(data.id);
  }

  @MessagePattern(CATALOG_PATTERNS.GET_DISCOUNTS)
  getDiscounts() {
    return this.catalogService.getDiscounts();
  }

  @MessagePattern(CATALOG_PATTERNS.CREATE_DISCOUNT)
  createDiscount(@Payload() dto: CreateDiscountDto) {
    return this.catalogService.createDiscount(dto);
  }

  @MessagePattern(CATALOG_PATTERNS.UPDATE_DISCOUNT)
  updateDiscount(@Payload() data: { id: string; dto: UpdateDiscountDto }) {
    return this.catalogService.updateDiscount(data.id, data.dto);
  }

  @MessagePattern(CATALOG_PATTERNS.DELETE_DISCOUNT)
  deleteDiscount(@Payload() data: { id: string }) {
    return this.catalogService.deleteDiscount(data.id);
  }

  @MessagePattern(CATALOG_PATTERNS.VALIDATE_DISCOUNT)
  validateDiscount(@Payload() data: { code: string; userId?: string }) {
    return this.catalogService.validateDiscount(data.code, data.userId);
  }

  @MessagePattern(CATALOG_PATTERNS.CHECK_STOCK)
  checkStock(
    @Payload() data: { items: Array<{ productId: string; quantity: number }> },
  ) {
    return this.catalogService.checkStock(data.items);
  }
}
