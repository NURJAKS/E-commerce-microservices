import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
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
  REFUNDING = 'REFUNDING',
  REFUNDED = 'REFUNDED',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
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
  GET_SESSIONS: 'auth.sessions.list',
  REVOKE_SESSION: 'auth.sessions.revoke',
  REVOKE_ALL_SESSIONS: 'auth.sessions.revoke_all',
  SETUP_2FA: 'auth.2fa.setup',
  ENABLE_2FA: 'auth.2fa.enable',
  DISABLE_2FA: 'auth.2fa.disable',
  OAUTH_GOOGLE_LOGIN: 'auth.oauth.google',
} as const;

export const CATALOG_PATTERNS = {
  GET_CATEGORIES: 'catalog.categories.list',
  CREATE_CATEGORY: 'catalog.categories.create',
  GET_PRODUCTS: 'catalog.products.list',
  GET_PRODUCT_BY_ID: 'catalog.products.get',
  AUTOCOMPLETE_PRODUCTS: 'catalog.products.autocomplete',
  GET_POPULAR_SEARCHES: 'catalog.search.popular',
  RECORD_PRODUCT_VIEW: 'catalog.products.record_view',
  GET_RECENTLY_VIEWED: 'catalog.products.recently_viewed',
  GET_PRODUCT_REVIEWS: 'catalog.reviews.list',
  CREATE_PRODUCT_REVIEW: 'catalog.reviews.create',
  SUBSCRIBE_STOCK_ALERT: 'catalog.stock_alert.subscribe',
  CHECK_STOCK_ALERT: 'catalog.stock_alert.check',
  CREATE_PRODUCT: 'catalog.products.create',
  UPDATE_PRODUCT: 'catalog.products.update',
  DELETE_PRODUCT: 'catalog.products.delete',
  GET_DISCOUNTS: 'catalog.discounts.list',
  CREATE_DISCOUNT: 'catalog.discounts.create',
  UPDATE_DISCOUNT: 'catalog.discounts.update',
  DELETE_DISCOUNT: 'catalog.discounts.delete',
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
  REQUEST_REFUND: 'order.refund.request',
  GET_INVOICE_URL: 'order.invoice.get_url',
} as const;

export const PAYMENT_PATTERNS = {
  GET_ORDER_PAYMENT: 'payment.get.byOrder',
  HANDLE_STRIPE_WEBHOOK: 'payment.webhook.stripe',
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
}

export class LoginDto {
  @ApiProperty({ example: 'customer@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongPass123!' })
  @IsString()
  @IsNotEmpty()
  password!: string;

  @ApiPropertyOptional({
    example: '123456',
    description: '6-digit TOTP code from Google Authenticator (when 2FA is enabled)',
  })
  @IsOptional()
  @IsString()
  totpCode?: string;
}

export class TotpCodeDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @IsNotEmpty()
  code!: string;
}

export interface SessionMetadata {
  userAgent?: string;
  ipAddress?: string;
}

export interface SessionDto {
  id: string;
  familyId: string;
  deviceName: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface TotpSetupResponse {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
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
  authProvider?: string;
  avatarUrl?: string | null;
  totpEnabled?: boolean;
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

  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({ example: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  inStockOnly?: boolean;

  @ApiPropertyOptional({
    enum: ['relevance', 'newest', 'price_asc', 'price_desc'],
    default: 'newest',
  })
  @IsOptional()
  @IsString()
  sortBy?: 'relevance' | 'newest' | 'price_asc' | 'price_desc';

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

export interface ProductSuggestionDto {
  id: string;
  title: string;
  price: number;
  stock: number;
  image?: string;
  categoryName?: string;
}

export interface PopularSearchDto {
  term: string;
  count: number;
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

  @ApiPropertyOptional({
    example: 100,
    description: 'Maximum total redemptions across all users (null = unlimited)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxUses?: number | null;

  @ApiPropertyOptional({
    example: 1,
    description: 'Maximum redemptions per user (null = unlimited)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxUsesPerUser?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateDiscountDto {
  @ApiPropertyOptional({ example: 15 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  percentage?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  fixedAmount?: number;

  @ApiPropertyOptional({ example: '2025-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @ApiPropertyOptional({ example: '2028-12-31T23:59:59.000Z' })
  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxUses?: number | null;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxUsesPerUser?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PresignUploadDto {
  @ApiProperty({ example: 'keyboard-hero.webp' })
  @IsString()
  @IsNotEmpty()
  fileName!: string;

  @ApiProperty({ example: 'image/webp' })
  @IsString()
  @IsNotEmpty()
  contentType!: string;

  @ApiProperty({ example: 245760, description: 'Exact file size in bytes (max 10 MB)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  sizeBytes!: number;
}

export interface PresignedUploadResponse {
  uploadUrl: string;
  key: string;
  publicUrl: string;
  expiresInSeconds: number;
  requiredHeaders: Record<string, string>;
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
  avgRating?: number;
  reviewsCount?: number;
}

export class CreateReviewDto {
  @ApiProperty({ example: 5, minimum: 1, maximum: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiProperty({ example: 'Excellent tactile switches and rock-solid build quality.' })
  @IsString()
  @MinLength(3)
  comment!: string;
}

export interface ReviewDto {
  id: string;
  productId: string;
  userId: string;
  userEmail: string;
  rating: number;
  comment: string;
  verifiedPurchase: boolean;
  createdAt: string;
}

export interface ProductReviewsResponse {
  productId: string;
  avgRating: number;
  reviewsCount: number;
  canReview: boolean;
  hasReviewed: boolean;
  items: ReviewDto[];
}

export class SubscribeStockAlertDto {
  @ApiPropertyOptional({ example: 'customer@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;
}

export interface StockAlertSubscriber {
  userId?: string | null;
  email: string;
}

export interface ProductRestockedEvent {
  productId: string;
  productTitle: string;
  price: number;
  stock: number;
  image?: string;
  subscribers: StockAlertSubscriber[];
  restockedAt: string;
}

export interface ProductRestockedWsPayload {
  productId: string;
  productTitle: string;
  price: number;
  stock: number;
  message: string;
  restockedAt: string;
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
  maxUses: number | null;
  maxUsesPerUser: number | null;
  usedCount: number;
  isActive: boolean;
}

export interface ValidateDiscountResult {
  valid: boolean;
  code: string;
  percentage: number;
  fixedAmount: number;
  reason?: string;
}

export interface StockCheckQuotedItem {
  productId: string;
  productTitle: string;
  unitPrice: number;
  quantity: number;
}

export interface StockCheckResponse {
  available: boolean;
  unavailableItem?: string;
  quotedItems?: StockCheckQuotedItem[];
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

export class RequestRefundDto {
  @ApiPropertyOptional({ example: 'Item no longer needed' })
  @IsOptional()
  @IsString()
  reason?: string;
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
  invoiceKey?: string | null;
  createdAt: string;
  items: OrderItemDto[];
}

export interface InvoiceDownloadResponse {
  downloadUrl: string;
  fileName: string;
  expiresInSeconds: number;
}

export interface InvoiceGeneratedEvent {
  orderId: string;
  userId: string;
  invoiceKey: string;
  generatedAt: string;
}

export interface PaymentDto {
  id: string;
  orderId: string;
  userId: string;
  amount: number;
  status: PaymentStatus;
  provider?: string;
  transactionId: string | null;
  stripeSessionId?: string | null;
  checkoutUrl?: string | null;
  refundTransactionId?: string | null;
  refundedAt?: string | null;
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
  items?: SagaOrderItem[];
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

export interface OrderRefundRequestedEvent {
  orderId: string;
  userId: string;
  userEmail?: string;
  items: SagaOrderItem[];
  amount: number;
  reason: string;
  requestedAt: string;
}

export interface PaymentRefundedEvent {
  paymentId: string;
  orderId: string;
  userId: string;
  userEmail?: string;
  items: SagaOrderItem[];
  amount: number;
  refundTransactionId: string;
  reason: string;
  refundedAt: string;
}

export interface OrderStatusUpdatedWsPayload {
  orderId: string;
  userId: string;
  status: OrderStatus;
  message: string;
  transactionId?: string;
  updatedAt: string;
}
