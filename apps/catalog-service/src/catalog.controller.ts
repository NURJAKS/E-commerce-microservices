import { Controller, UseFilters, UseInterceptors } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  CATALOG_PATTERNS,
  CreateCategoryDto,
  CreateDiscountDto,
  CreateProductDto,
  ProductQueryDto,
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

  @MessagePattern(CATALOG_PATTERNS.VALIDATE_DISCOUNT)
  validateDiscount(@Payload() data: { code: string }) {
    return this.catalogService.validateDiscount(data.code);
  }

  @MessagePattern(CATALOG_PATTERNS.CHECK_STOCK)
  checkStock(
    @Payload() data: { items: Array<{ productId: string; quantity: number }> },
  ) {
    return this.catalogService.checkStock(data.items);
  }
}
