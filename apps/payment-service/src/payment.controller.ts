import { Controller, UseFilters, UseInterceptors } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { PAYMENT_PATTERNS, UserRole } from '@shop/contracts';
import { AllRpcExceptionFilter, LoggingInterceptor } from '@shop/common';
import { PaymentService } from './payment.service';

@Controller()
@UseFilters(new AllRpcExceptionFilter())
@UseInterceptors(new LoggingInterceptor())
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @MessagePattern(PAYMENT_PATTERNS.GET_ORDER_PAYMENT)
  getPaymentByOrder(
    @Payload() data: { orderId: string; userId?: string; userRole?: UserRole },
  ) {
    return this.paymentService.getPaymentByOrderId(
      data.orderId,
      data.userId,
      data.userRole,
    );
  }

  @MessagePattern(PAYMENT_PATTERNS.HANDLE_STRIPE_WEBHOOK)
  handleStripeWebhook(
    @Payload()
    data: {
      rawBody: string;
      signature: string;
      __headers?: { 'x-trace-id'?: string };
    },
  ) {
    return this.paymentService.handleStripeWebhook(
      data.rawBody,
      data.signature,
      data.__headers?.['x-trace-id'],
    );
  }
}
