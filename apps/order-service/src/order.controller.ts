import { Controller, UseFilters, UseInterceptors } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AddCartItemDto,
  ORDER_PATTERNS,
  UpdateCartItemDto,
} from '@shop/contracts';
import { AllRpcExceptionFilter, LoggingInterceptor } from '@shop/common';
import { CartService } from './cart.service';
import { OrderService } from './order.service';

@Controller()
@UseFilters(new AllRpcExceptionFilter())
@UseInterceptors(new LoggingInterceptor())
export class OrderController {
  constructor(
    private readonly cartService: CartService,
    private readonly orderService: OrderService,
  ) {}

  @MessagePattern(ORDER_PATTERNS.GET_CART)
  getCart(@Payload() data: { userId: string }) {
    return this.cartService.getCart(data.userId);
  }

  @MessagePattern(ORDER_PATTERNS.ADD_CART_ITEM)
  addCartItem(@Payload() data: { userId: string; dto: AddCartItemDto }) {
    return this.cartService.addItem(data.userId, data.dto);
  }

  @MessagePattern(ORDER_PATTERNS.UPDATE_CART_ITEM)
  updateCartItem(@Payload() data: { userId: string; dto: UpdateCartItemDto }) {
    return this.cartService.updateQuantity(
      data.userId,
      data.dto.productId,
      data.dto.quantity,
    );
  }

  @MessagePattern(ORDER_PATTERNS.REMOVE_CART_ITEM)
  removeCartItem(@Payload() data: { userId: string; productId: string }) {
    return this.cartService.removeItem(data.userId, data.productId);
  }

  @MessagePattern(ORDER_PATTERNS.CLEAR_CART)
  clearCart(@Payload() data: { userId: string }) {
    return this.cartService.clearCart(data.userId);
  }

  @MessagePattern(ORDER_PATTERNS.CHECKOUT)
  checkout(
    @Payload()
    data: {
      userId: string;
      userEmail?: string;
      discountCode?: string;
      __headers?: { 'x-trace-id'?: string };
    },
  ) {
    return this.orderService.checkout(
      data.userId,
      data.userEmail,
      data.discountCode,
      data.__headers?.['x-trace-id'],
    );
  }

  @MessagePattern(ORDER_PATTERNS.GET_USER_ORDERS)
  getUserOrders(@Payload() data: { userId: string }) {
    return this.orderService.getUserOrders(data.userId);
  }

  @MessagePattern(ORDER_PATTERNS.GET_ORDER_BY_ID)
  getOrderById(@Payload() data: { orderId: string; userId?: string }) {
    return this.orderService.getOrderById(data.orderId, data.userId);
  }
}
