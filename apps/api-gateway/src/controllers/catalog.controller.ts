import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom } from 'rxjs';
import { CurrentUser, Public, Roles, withInternalHeaders } from '@shop/common';
import {
  CATALOG_PATTERNS,
  CreateCategoryDto,
  CreateDiscountDto,
  CreateProductDto,
  CreateReviewDto,
  CurrentUserPayload,
  PresignUploadDto,
  ProductQueryDto,
  SERVICES,
  SubscribeStockAlertDto,
  UpdateDiscountDto,
  UpdateProductDto,
  UserRole,
} from '@shop/contracts';
import { MinioService } from '../minio.service';

@ApiTags('Catalog')
@Controller('catalog')
export class CatalogGatewayController {
  constructor(
    @Inject(SERVICES.CATALOG) private readonly catalogClient: ClientProxy,
    @Inject(MinioService) private readonly minioService: MinioService,
  ) {}

  @Public()
  @Get('categories')
  @ApiOperation({ summary: 'List all product categories (cached in Redis)' })
  getCategories() {
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.GET_CATEGORIES, {}),
    );
  }

  @ApiBearerAuth()
  @Roles(UserRole.ADMIN)
  @Post('categories')
  @ApiOperation({ summary: 'Create a new category (Admin only)' })
  createCategory(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.catalogClient.send(
        CATALOG_PATTERNS.CREATE_CATEGORY,
        withInternalHeaders(dto, user),
      ),
    );
  }

  @Public()
  @Get('products')
  @ApiOperation({
    summary:
      'List products with PostgreSQL FTS + pg_trgm fuzzy search, price/category/stock filters & pagination',
  })
  getProducts(@Query() query: ProductQueryDto) {
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.GET_PRODUCTS, query),
    );
  }

  @Public()
  @Get('products/autocomplete')
  @ApiOperation({
    summary: 'Typo-tolerant product autocomplete using PostgreSQL pg_trgm & FTS',
  })
  autocompleteProducts(
    @Query('q') q = '',
    @Query('limit') limit?: string,
  ) {
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.AUTOCOMPLETE_PRODUCTS, {
        q,
        limit: limit ? Number(limit) : 6,
      }),
    );
  }

  @Public()
  @Get('search/popular')
  @ApiOperation({
    summary: 'Top trending search queries from Redis Sorted Set (ZREVRANGE)',
  })
  getPopularSearches(@Query('limit') limit?: string) {
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.GET_POPULAR_SEARCHES, {
        limit: limit ? Number(limit) : 8,
      }),
    );
  }

  @Public()
  @Get('products/recently-viewed')
  @ApiOperation({
    summary:
      'Recently viewed products from Redis Sorted Set for authenticated user or X-Viewer-Id',
  })
  getRecentlyViewed(
    @CurrentUser() user?: CurrentUserPayload,
    @Headers('x-viewer-id') viewerHeader?: string,
    @Query('limit') limit?: string,
  ) {
    const viewerId = user?.userId || viewerHeader || '';
    if (!viewerId) {
      return [];
    }
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.GET_RECENTLY_VIEWED, {
        viewerId,
        limit: limit ? Number(limit) : 6,
      }),
    );
  }

  @Public()
  @Post('products/:id/view')
  @ApiOperation({
    summary: 'Record product view in Redis Sorted Set (Recently Viewed)',
  })
  recordProductView(
    @Param('id') id: string,
    @CurrentUser() user?: CurrentUserPayload,
    @Headers('x-viewer-id') viewerHeader?: string,
  ) {
    const viewerId = user?.userId || viewerHeader || '';
    if (!viewerId) {
      return { recorded: false };
    }
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.RECORD_PRODUCT_VIEW, {
        viewerId,
        productId: id,
      }),
    );
  }

  @Public()
  @Get('products/:id')
  @ApiOperation({ summary: 'Get single product details by ID' })
  getProductById(@Param('id') id: string) {
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.GET_PRODUCT_BY_ID, { id }),
    );
  }

  @Public()
  @Get('products/:id/reviews')
  @ApiOperation({
    summary:
      'Get Verified Purchase reviews and viewer eligibility for a product',
  })
  getProductReviews(
    @Param('id') id: string,
    @CurrentUser() user?: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.GET_PRODUCT_REVIEWS, {
        productId: id,
        viewerUserId: user?.userId,
      }),
    );
  }

  @ApiBearerAuth()
  @Post('products/:id/reviews')
  @ApiOperation({
    summary:
      'Submit a Verified Purchase review (enforced via local payment.succeeded projection)',
  })
  createProductReview(
    @Param('id') id: string,
    @Body() dto: CreateReviewDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.catalogClient.send(
        CATALOG_PATTERNS.CREATE_PRODUCT_REVIEW,
        withInternalHeaders(
          {
            productId: id,
            userId: user.userId,
            userEmail: user.email || '',
            dto,
          },
          user,
        ),
      ),
    );
  }

  @Public()
  @Get('products/:id/stock-alert')
  @ApiOperation({
    summary: 'Check whether user/email is subscribed to Back-in-Stock alerts',
  })
  checkStockAlert(
    @Param('id') id: string,
    @Query('email') email?: string,
    @CurrentUser() user?: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.CHECK_STOCK_ALERT, {
        productId: id,
        email: email || user?.email,
        userId: user?.userId,
      }),
    );
  }

  @Public()
  @Post('products/:id/stock-alert')
  @ApiOperation({
    summary:
      'Subscribe to Back-in-Stock email & WebSocket alert for an out-of-stock product',
  })
  subscribeStockAlert(
    @Param('id') id: string,
    @Body() dto: SubscribeStockAlertDto,
    @CurrentUser() user?: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.SUBSCRIBE_STOCK_ALERT, {
        productId: id,
        email: dto?.email || user?.email || '',
        userId: user?.userId,
      }),
    );
  }

  @ApiBearerAuth()
  @Roles(UserRole.ADMIN)
  @Post('products')
  @ApiOperation({ summary: 'Create a new product (Admin only)' })
  createProduct(
    @Body() dto: CreateProductDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.catalogClient.send(
        CATALOG_PATTERNS.CREATE_PRODUCT,
        withInternalHeaders(dto, user),
      ),
    );
  }

  @ApiBearerAuth()
  @Roles(UserRole.ADMIN)
  @Patch('products/:id')
  @ApiOperation({ summary: 'Update a product by ID (Admin only)' })
  updateProduct(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.catalogClient.send(
        CATALOG_PATTERNS.UPDATE_PRODUCT,
        withInternalHeaders({ id, dto }, user),
      ),
    );
  }

  @ApiBearerAuth()
  @Roles(UserRole.ADMIN)
  @Delete('products/:id')
  @ApiOperation({ summary: 'Delete a product by ID (Admin only)' })
  deleteProduct(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.catalogClient.send(
        CATALOG_PATTERNS.DELETE_PRODUCT,
        withInternalHeaders({ id }, user),
      ),
    );
  }

  @Public()
  @Get('discounts')
  @ApiOperation({ summary: 'List active discount promo codes' })
  getDiscounts() {
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.GET_DISCOUNTS, {}),
    );
  }

  @Public()
  @Get('discounts/validate/:code')
  @ApiOperation({ summary: 'Validate a discount promo code' })
  validateDiscount(
    @Param('code') code: string,
    @CurrentUser() user?: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.VALIDATE_DISCOUNT, {
        code,
        userId: user?.userId,
      }),
    );
  }

  @ApiBearerAuth()
  @Roles(UserRole.ADMIN)
  @Post('discounts')
  @ApiOperation({ summary: 'Create a new discount promo code (Admin only)' })
  createDiscount(
    @Body() dto: CreateDiscountDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.catalogClient.send(
        CATALOG_PATTERNS.CREATE_DISCOUNT,
        withInternalHeaders(dto, user),
      ),
    );
  }

  @ApiBearerAuth()
  @Roles(UserRole.ADMIN)
  @Patch('discounts/:id')
  @ApiOperation({
    summary:
      'Update discount promo code validity, limits, or status (Admin only)',
  })
  updateDiscount(
    @Param('id') id: string,
    @Body() dto: UpdateDiscountDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.catalogClient.send(
        CATALOG_PATTERNS.UPDATE_DISCOUNT,
        withInternalHeaders({ id, dto }, user),
      ),
    );
  }

  @ApiBearerAuth()
  @Roles(UserRole.ADMIN)
  @Delete('discounts/:id')
  @ApiOperation({ summary: 'Delete a discount promo code (Admin only)' })
  deleteDiscount(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.catalogClient.send(
        CATALOG_PATTERNS.DELETE_DISCOUNT,
        withInternalHeaders({ id }, user),
      ),
    );
  }

  @ApiBearerAuth()
  @Roles(UserRole.ADMIN)
  @Post('upload/presign')
  @ApiOperation({
    summary:
      'Generate a 60s Presigned PUT URL for direct browser-to-MinIO image upload (Admin only)',
  })
  presignUpload(@Body() dto: PresignUploadDto) {
    return this.minioService.createPresignedUploadUrl(dto);
  }

  @ApiBearerAuth()
  @Roles(UserRole.ADMIN)
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload product image to MinIO S3 (products-media bucket)',
  })
  uploadImage(@UploadedFile() file: any) {
    return this.minioService.uploadProductImage(file);
  }
}
