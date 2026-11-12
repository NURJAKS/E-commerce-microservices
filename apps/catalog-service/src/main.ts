import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { CatalogModule } from './catalog.module';

async function bootstrap() {
  const logger = new Logger('CatalogService');
  const host = process.env.CATALOG_SERVICE_HOST || '0.0.0.0';
  const port = Number(process.env.CATALOG_SERVICE_PORT || 3002);

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    CatalogModule,
    {
      transport: Transport.TCP,
      options: {
        host,
        port,
      },
    },
  );

  await app.listen();
  logger.log(`Catalog Microservice listening on TCP ${host}:${port}`);
}

bootstrap();
