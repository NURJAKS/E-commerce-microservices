import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { HttpExceptionFilter, LoggingInterceptor } from '@shop/common';
import { GatewayModule } from './gateway.module';

async function bootstrap() {
  const logger = new Logger('ApiGateway');
  const port = Number(process.env.API_GATEWAY_PORT || 3000);

  const allowedOrigins = (
    process.env.CORS_ORIGINS ||
    'http://localhost,http://localhost:80,http://localhost:5173'
  )
    .split(',')
    .map((o) => o.trim());

  const app = await NestFactory.create(GatewayModule);
  app.setGlobalPrefix('api');

  // Security Headers (Helmet: HSTS, X-Frame-Options, X-Content-Type-Options, XSS Filter)
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Strict CORS with HttpOnly Cookie Credentials support
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Idempotency-Key',
      'X-Trace-Id',
    ],
    exposedHeaders: ['X-Trace-Id', 'X-Idempotency-Replayed'],
  });

  // Parse HttpOnly cookies (for refresh_token)
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('NovaShop — Event-Driven Microservices API Gateway')
    .setDescription(
      'REST API Gateway featuring Transactional Outbox, Idempotency-Key deduplication, JWT Blacklisting, HttpOnly Cookie Refresh Rotation, and WAF Rate Limiting',
    )
    .setVersion('2.0.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(port, '0.0.0.0');
  logger.log(
    `API Gateway listening on http://0.0.0.0:${port}/api (Swagger: /api/docs, Health: /api/health)`,
  );
}

bootstrap();
