import {
  Body,
  Controller,
  Delete,
  Get,
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
  CurrentUserPayload,
  ProductQueryDto,
  SERVICES,
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
    summary: 'List products with search, category filter & pagination',
  })
  getProducts(@Query() query: ProductQueryDto) {
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.GET_PRODUCTS, query),
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
  validateDiscount(@Param('code') code: string) {
    return firstValueFrom(
      this.catalogClient.send(CATALOG_PATTERNS.VALIDATE_DISCOUNT, { code }),
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
