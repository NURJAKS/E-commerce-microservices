import { Controller, Get, Inject, Module } from '@nestjs/common';
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
import {
  DependencyHealthIndicator,
  Public,
  resolveJwtAccessSecret,
} from '@shop/common';
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
    @Inject(HealthCheckService)
    private readonly health: HealthCheckService,
    @Inject(MemoryHealthIndicator)
    private readonly memory: MemoryHealthIndicator,
    @Inject(DependencyHealthIndicator)
    private readonly deps: DependencyHealthIndicator,
    @Inject(SecurityRedisService)
    private readonly securityRedis: SecurityRedisService,
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
      () => this.deps.checkRedis('redis', () => this.securityRedis.ping()),
    ]);
  }

  @Public()
  @Get('live')
  @HealthCheck()
  liveness() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
    ]);
  }

  @Public()
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.deps.checkRedis('redis', () => this.securityRedis.ping()),
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
      secret: resolveJwtAccessSecret('api-gateway'),
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
    DependencyHealthIndicator,
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
