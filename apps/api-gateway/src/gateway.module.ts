import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  TerminusModule,
} from '@nestjs/terminus';
import { ThrottlerModule } from '@nestjs/throttler';
import { Public } from '@shop/common';
import { SERVICES } from '@shop/contracts';
import { AuthGatewayController } from './controllers/auth.controller';
import { CatalogGatewayController } from './controllers/catalog.controller';
import { OrderGatewayController } from './controllers/order.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { WafThrottlerGuard } from './guards/waf-throttler.guard';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor';
import { MinioService } from './minio.service';
import { SecurityRedisService } from './security-redis.service';

@Controller('health')
export class HealthGatewayController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
    ]);
  }
}

@Module({
  imports: [
    TerminusModule,
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
    JwtModule.register({
      secret:
        process.env.JWT_ACCESS_SECRET ||
        'super-secret-jwt-access-key-shop-2026',
    }),
    ClientsModule.register([
      {
        name: SERVICES.AUTH,
        transport: Transport.TCP,
        options: {
          host: process.env.AUTH_SERVICE_HOST || 'localhost',
          port: Number(process.env.AUTH_SERVICE_PORT || 3001),
        },
      },
      {
        name: SERVICES.CATALOG,
        transport: Transport.TCP,
        options: {
          host: process.env.CATALOG_SERVICE_HOST || 'localhost',
          port: Number(process.env.CATALOG_SERVICE_PORT || 3002),
        },
      },
      {
        name: SERVICES.ORDER,
        transport: Transport.TCP,
        options: {
          host: process.env.ORDER_SERVICE_HOST || 'localhost',
          port: Number(process.env.ORDER_SERVICE_PORT || 3003),
        },
      },
      {
        name: SERVICES.PAYMENT,
        transport: Transport.TCP,
        options: {
          host: process.env.PAYMENT_SERVICE_HOST || 'localhost',
          port: Number(process.env.PAYMENT_SERVICE_PORT || 3004),
        },
      },
    ]),
  ],
  controllers: [
    HealthGatewayController,
    AuthGatewayController,
    CatalogGatewayController,
    OrderGatewayController,
  ],
  providers: [
    MinioService,
    SecurityRedisService,
    IdempotencyInterceptor,
    {
      provide: APP_GUARD,
      useClass: WafThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class GatewayModule {}
