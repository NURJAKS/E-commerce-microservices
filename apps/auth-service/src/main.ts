import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AuthModule } from './auth.module';

async function bootstrap() {
  const logger = new Logger('AuthService');
  const host = process.env.AUTH_SERVICE_HOST || '0.0.0.0';
  const port = Number(process.env.AUTH_SERVICE_PORT || 3001);

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AuthModule,
    {
      transport: Transport.TCP,
      options: {
        host,
        port,
      },
    },
  );

  await app.listen();
  logger.log(`Auth Microservice listening on TCP ${host}:${port}`);
}

bootstrap();
