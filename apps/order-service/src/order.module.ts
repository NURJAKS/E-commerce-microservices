import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { SERVICES } from '@shop/contracts';
import { RabbitMQModule } from '@shop/rmq';
import { CartService } from './cart.service';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
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
  controllers: [OrderController],
  providers: [PrismaService, CartService, OrderService],
})
export class OrderModule {}
