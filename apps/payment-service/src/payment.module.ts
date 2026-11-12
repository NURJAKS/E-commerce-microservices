import { Module } from '@nestjs/common';
import { RabbitMQModule } from '@shop/rmq';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    RabbitMQModule.forRoot({
      serviceName: 'payment-service',
    }),
  ],
  controllers: [PaymentController],
  providers: [PrismaService, PaymentService],
})
export class PaymentModule {}
