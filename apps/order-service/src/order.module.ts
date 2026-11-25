import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import { DependencyHealthIndicator } from '@shop/common';
import { SERVICES } from '@shop/contracts';
import { RabbitMQModule } from '@shop/rmq';
import { CartService } from './cart.service';
import { HealthController } from './health.controller';
import { InvoiceStorageService } from './invoice-storage.service';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    TerminusModule,
    ScheduleModule.forRoot(),
    RabbitMQModule.forRoot({
      serviceName: 'order-service',
    }),
    ClientsModule.register([
      {
        name: SERVICES.CATALOG,
        transport: Transport.TCP,
        options: {
          host: process.env.CATALOG_SERVICE_HOST || 'localhost',
          port: Number(process.env.CATALOG_SERVICE_PORT || 3002),
        },
      },
    ]),
  ],
  controllers: [OrderController, HealthController],
  providers: [
    DependencyHealthIndicator,
    PrismaService,
    CartService,
    InvoiceStorageService,
    OrderService,
  ],
})
export class OrderModule {}
