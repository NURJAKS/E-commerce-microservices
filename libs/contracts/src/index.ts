import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ==========================================
// Domain Enums
// ==========================================

export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  ADMIN = 'ADMIN',
}

export enum OrderStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

// ==========================================
// Microservice Injection Tokens & Patterns
// ==========================================

export const SERVICES = {
  AUTH: 'AUTH_SERVICE',
  CATALOG: 'CATALOG_SERVICE',
  ORDER: 'ORDER_SERVICE',
  PAYMENT: 'PAYMENT_SERVICE',
  NOTIFICATION: 'NOTIFICATION_SERVICE',
} as const;

export const AUTH_PATTERNS = {
  REGISTER: 'auth.register',
  LOGIN: 'auth.login',
  REFRESH: 'auth.refresh',
  LOGOUT: 'auth.logout',
  ME: 'auth.me',
} as const;

export const CATALOG_PATTERNS = {
  GET_CATEGORIES: 'catalog.categories.list',
  CREATE_CATEGORY: 'catalog.categories.create',
  GET_PRODUCTS: 'catalog.products.list',
  GET_PRODUCT_BY_ID: 'catalog.products.get',
  CREATE_PRODUCT: 'catalog.products.create',
  UPDATE_PRODUCT: 'catalog.products.update',
  DELETE_PRODUCT: 'catalog.products.delete',
  GET_DISCOUNTS: 'catalog.discounts.list',
  CREATE_DISCOUNT: 'catalog.discounts.create',
  VALIDATE_DISCOUNT: 'catalog.discounts.validate',
  CHECK_STOCK: 'catalog.stock.check',
} as const;

export const ORDER_PATTERNS = {
  GET_CART: 'order.cart.get',
  ADD_CART_ITEM: 'order.cart.add',
  UPDATE_CART_ITEM: 'order.cart.update',
  REMOVE_CART_ITEM: 'order.cart.remove',
  CLEAR_CART: 'order.cart.clear',
  CHECKOUT: 'order.checkout',
  GET_USER_ORDERS: 'order.list.user',
  GET_ORDER_BY_ID: 'order.get.id',
} as const;

export const PAYMENT_PATTERNS = {
  GET_ORDER_PAYMENT: 'payment.get.byOrder',
} as const;

// ==========================================
// Auth DTOs & Interfaces
// ==========================================

export class RegisterDto {
  @ApiProperty({ example: 'customer@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongPass123!', minLength: 6 })
  @IsString()
  @MinLength(6)
  password!: string;

  @ApiPropertyOptional({ enum: UserRole, default: UserRole.CUSTOMER })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}

export class LoginDto {
  @ApiProperty({ example: 'customer@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongPass123!' })
  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Cryptographic refresh token' })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  jti?: string;
  exp?: number;
}

export interface CurrentUserPayload {
  userId: string;
  email?: string;
  role: UserRole;
  jti?: string;
  exp?: number;
  traceId?: string;
}

export interface UserDto {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

export interface AuthTokensResponse {
  user: UserDto;
  accessToken: string;
  refreshToken: string;
}

// ==========================================
// Catalog DTOs & Interfaces
// ==========================================

export class CreateCategoryDto {
  @ApiProperty({ example: 'Electronics' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'electronics' })
  @IsString()
  @IsNotEmpty()
  slug!: string;

  @ApiPropertyOptional({ example: null })
  @IsOptional()
  @IsString()
  parentId?: string | null;
}

export class CreateProductDto {
  @ApiProperty({ example: 'Mechanical Wireless Keyboard' })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiProperty({ example: 'Hot-swappable RGB tactile mechanical keyboard' })
  @IsString()
  @IsNotEmpty()
  description!: string;

  @ApiProperty({ example: 149.99 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  price!: number;

  @ApiProperty({ example: 25 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stock!: number;

  @ApiPropertyOptional({ type: [String], example: ['http://localhost:9000/products-media/keyboard.jpg'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @ApiProperty({ example: 'uuid-of-category' })
  @IsString()
  @IsNotEmpty()
  categoryId!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  price?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stock?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ProductQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 12;
}

export class CreateDiscountDto {
  @ApiProperty({ example: 'WELCOME20' })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiPropertyOptional({ example: 20, description: 'Percentage discount (0-100)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  percentage?: number;

  @ApiPropertyOptional({ example: 0, description: 'Fixed amount discount' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  fixedAmount?: number;

  @ApiProperty({ example: '2025-01-01T00:00:00.000Z' })
  @IsDateString()
  validFrom!: string;

  @ApiProperty({ example: '2028-12-31T23:59:59.000Z' })
  @IsDateString()
  validUntil!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export interface CategoryDto {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

export interface ProductDto {
  id: string;
  title: string;
  description: string;
  price: number;
  stock: number;
  images: string[];
  categoryId: string;
  category?: CategoryDto;
  isActive: boolean;
  version?: number;
}

export interface PaginatedProductsResponse {
  items: ProductDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface DiscountDto {
  id: string;
  code: string;
  percentage: number;
  fixedAmount: number;
  validFrom: string;
  validUntil: string;
  isActive: boolean;
}

export interface ValidateDiscountResult {
  valid: boolean;
  code: string;
  percentage: number;
  fixedAmount: number;
  reason?: string;
}

// ==========================================
// Cart & Order DTOs & Interfaces
// ==========================================

export class AddCartItemDto {
  @ApiProperty({ example: 'uuid-of-product' })
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @ApiProperty({ example: 'Mechanical Wireless Keyboard' })
  @IsString()
  @IsNotEmpty()
  productTitle!: string;

  @ApiProperty({ example: 149.99 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  unitPrice!: number;

  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image?: string;
}

export class UpdateCartItemDto {
  @ApiProperty({ example: 'uuid-of-product' })
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  quantity!: number;
}

export interface CartItemDto {
  productId: string;
  productTitle: string;
  unitPrice: number;
  quantity: number;
  image?: string;
}

export interface CartDto {
  userId: string;
  items: CartItemDto[];
  subtotal: number;
  updatedAt: string;
}

export class CheckoutOrderDto {
  @ApiPropertyOptional({ example: 'WELCOME20' })
  @IsOptional()
  @IsString()
  discountCode?: string;
}

export interface OrderItemDto {
  id: string;
  orderId: string;
  productId: string;
  productTitle: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderDto {
  id: string;
  userId: string;
  status: OrderStatus;
  totalAmount: number;
  discountCode: string | null;
  createdAt: string;
  items: OrderItemDto[];
}

export interface PaymentDto {
  id: string;
  orderId: string;
  userId: string;
  amount: number;
  status: PaymentStatus;
  transactionId: string | null;
  createdAt: string;
}

// ==========================================
// Choreography Saga Event Payloads (RabbitMQ)
// ==========================================

export interface UserRegisteredEvent {
  userId: string;
  email: string;
  role: UserRole;
  registeredAt: string;
}

export interface SagaOrderItem {
  productId: string;
  productTitle: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderCreatedEvent {
  orderId: string;
  userId: string;
  userEmail?: string;
  items: SagaOrderItem[];
  totalAmount: number;
  discountCode?: string | null;
  createdAt: string;
}

export interface StockReservedEvent {
  orderId: string;
  userId: string;
  userEmail?: string;
  items: SagaOrderItem[];
  totalAmount: number;
  discountCode?: string | null;
  reservedAt: string;
}

export interface StockFailedEvent {
  orderId: string;
  userId: string;
  userEmail?: string;
  reason: string;
  failedAt: string;
}

export interface PaymentSucceededEvent {
  paymentId: string;
  orderId: string;
  userId: string;
  userEmail?: string;
  amount: number;
  transactionId: string;
  paidAt: string;
}

export interface PaymentFailedEvent {
  paymentId: string;
  orderId: string;
  userId: string;
  userEmail?: string;
  items: SagaOrderItem[];
  amount: number;
  reason: string;
  failedAt: string;
}

export interface OrderCancelledEvent {
  orderId: string;
  userId: string;
  userEmail?: string;
  reason: string;
  cancelledAt: string;
}

export interface OrderStatusUpdatedWsPayload {
  orderId: string;
  userId: string;
  status: OrderStatus;
  message: string;
  transactionId?: string;
  updatedAt: string;
}
