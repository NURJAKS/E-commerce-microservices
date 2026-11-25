import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { PaymentModule } from './payment.module';

async function bootstrap() {
  const logger = new Logger('PaymentService');
  const host = process.env.PAYMENT_SERVICE_HOST || '0.0.0.0';
  const port = Number(process.env.PAYMENT_SERVICE_PORT || 3004);
  const healthPort = Number(process.env.PAYMENT_HEALTH_PORT || 3104);

  const app = await NestFactory.create(PaymentModule);
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
    `Payment Microservice listening on TCP ${host}:${port} (Health: http://0.0.0.0:${healthPort}/health/ready)`,
  );
}

bootstrap();
