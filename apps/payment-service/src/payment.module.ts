import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DependencyHealthIndicator } from '@shop/common';
import { RabbitMQModule } from '@shop/rmq';
import { HealthController } from './health.controller';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    TerminusModule,
    RabbitMQModule.forRoot({
      serviceName: 'payment-service',
    }),
  ],
  controllers: [PaymentController, HealthController],
  providers: [DependencyHealthIndicator, PrismaService, PaymentService],
})
export class PaymentModule {}
