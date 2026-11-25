import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { OrderModule } from './order.module';

async function bootstrap() {
  const logger = new Logger('OrderService');
  const host = process.env.ORDER_SERVICE_HOST || '0.0.0.0';
  const port = Number(process.env.ORDER_SERVICE_PORT || 3003);
  const healthPort = Number(process.env.ORDER_HEALTH_PORT || 3103);

  const app = await NestFactory.create(OrderModule);
  app.enableShutdownHooks();

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.TCP,
    options: {
      host,
      port,
    },
  });

  await app.startAllMicroservices();
  await app.listen(healthPort, '0.0.0.0');
  logger.log(
    `Order Microservice listening on TCP ${host}:${port} (Health: http://0.0.0.0:${healthPort}/health/ready)`,
  );
}

bootstrap();
