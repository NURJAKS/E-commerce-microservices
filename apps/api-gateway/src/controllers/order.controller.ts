import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom } from 'rxjs';
import { CurrentUser, withInternalHeaders } from '@shop/common';
import {
  AddCartItemDto,
  CheckoutOrderDto,
  CurrentUserPayload,
  ORDER_PATTERNS,
  PAYMENT_PATTERNS,
  SERVICES,
  UpdateCartItemDto,
} from '@shop/contracts';
import { IdempotencyInterceptor } from '../interceptors/idempotency.interceptor';

@ApiTags('Cart & Orders')
@ApiBearerAuth()
@Controller()
export class OrderGatewayController {
  constructor(
    @Inject(SERVICES.ORDER) private readonly orderClient: ClientProxy,
    @Inject(SERVICES.PAYMENT) private readonly paymentClient: ClientProxy,
  ) {}

  @Get('cart')
  @ApiOperation({ summary: 'Get current user Redis cart' })
  getCart(@CurrentUser() user: CurrentUserPayload) {
    return firstValueFrom(
      this.orderClient.send(
        ORDER_PATTERNS.GET_CART,
        withInternalHeaders({ userId: user.userId }, user),
      ),
    );
  }

  @Post('cart/items')
  @ApiOperation({ summary: 'Add item to Redis cart' })
  addCartItem(
    @Body() dto: AddCartItemDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.orderClient.send(
        ORDER_PATTERNS.ADD_CART_ITEM,
        withInternalHeaders({ userId: user.userId, dto }, user),
      ),
    );
  }

  @Patch('cart/items')
  @ApiOperation({ summary: 'Update item quantity in Redis cart' })
  updateCartItem(
    @Body() dto: UpdateCartItemDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.orderClient.send(
        ORDER_PATTERNS.UPDATE_CART_ITEM,
        withInternalHeaders({ userId: user.userId, dto }, user),
      ),
    );
  }

  @Delete('cart/items/:productId')
  @ApiOperation({ summary: 'Remove item from Redis cart' })
  removeCartItem(
    @Param('productId') productId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.orderClient.send(
        ORDER_PATTERNS.REMOVE_CART_ITEM,
        withInternalHeaders({ userId: user.userId, productId }, user),
      ),
    );
  }

  @Delete('cart')
  @ApiOperation({ summary: 'Clear current user Redis cart' })
  clearCart(@CurrentUser() user: CurrentUserPayload) {
    return firstValueFrom(
      this.orderClient.send(
        ORDER_PATTERNS.CLEAR_CART,
        withInternalHeaders({ userId: user.userId }, user),
      ),
    );
  }

  @Post('orders/checkout')
  @UseInterceptors(IdempotencyInterceptor)
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: false,
    description: 'UUID for 24-hour idempotent checkout deduplication in Redis',
  })
  @ApiOperation({
    summary:
      'Create order via Transactional Outbox and trigger Choreography Saga (Idempotent via X-Idempotency-Key)',
  })
  checkout(
    @Body() dto: CheckoutOrderDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.orderClient.send(
        ORDER_PATTERNS.CHECKOUT,
        withInternalHeaders(
          {
            userId: user.userId,
            userEmail: user.email,
            discountCode: dto.discountCode,
          },
          user,
        ),
      ),
    );
  }

  @Get('orders')
  @ApiOperation({ summary: 'List orders for authenticated user' })
  getUserOrders(@CurrentUser() user: CurrentUserPayload) {
    return firstValueFrom(
      this.orderClient.send(
        ORDER_PATTERNS.GET_USER_ORDERS,
        withInternalHeaders({ userId: user.userId }, user),
      ),
    );
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'Get order details by ID' })
  getOrderById(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.orderClient.send(
        ORDER_PATTERNS.GET_ORDER_BY_ID,
        withInternalHeaders({ orderId: id, userId: user.userId }, user),
      ),
    );
  }

  @Get('orders/:id/payment')
  @ApiOperation({ summary: 'Get payment transaction details for an order' })
  getOrderPayment(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.paymentClient.send(
        PAYMENT_PATTERNS.GET_ORDER_PAYMENT,
        withInternalHeaders({ orderId: id }, user),
      ),
    );
  }
}
