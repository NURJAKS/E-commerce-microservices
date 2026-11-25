import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { CatalogModule } from './catalog.module';

async function bootstrap() {
  const logger = new Logger('CatalogService');
  const host = process.env.CATALOG_SERVICE_HOST || '0.0.0.0';
  const port = Number(process.env.CATALOG_SERVICE_PORT || 3002);
  const healthPort = Number(process.env.CATALOG_HEALTH_PORT || 3102);

  const app = await NestFactory.create(CatalogModule);
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
    `Catalog Microservice listening on TCP ${host}:${port} (Health: http://0.0.0.0:${healthPort}/health/ready)`,
  );
}

bootstrap();
