import { Controller, UseFilters, UseInterceptors } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { PAYMENT_PATTERNS } from '@shop/contracts';
import { AllRpcExceptionFilter, LoggingInterceptor } from '@shop/common';
import { PaymentService } from './payment.service';

@Controller()
@UseFilters(new AllRpcExceptionFilter())
@UseInterceptors(new LoggingInterceptor())
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @MessagePattern(PAYMENT_PATTERNS.GET_ORDER_PAYMENT)
  getPaymentByOrder(@Payload() data: { orderId: string }) {
    return this.paymentService.getPaymentByOrderId(data.orderId);
  }
}
