import { Controller, Get, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  TerminusModule,
} from '@nestjs/terminus';
import {
  DependencyHealthIndicator,
  resolveJwtAccessSecret,
} from '@shop/common';
import { RabbitMQModule, RabbitMQService } from '@shop/rmq';
import { InvoicePdfService } from './invoice-pdf.service';
import { NotificationGateway } from './notification.gateway';
import { NotificationService } from './notification.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly deps: DependencyHealthIndicator,
    private readonly rmq: RabbitMQService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
      () => this.deps.checkRabbitMQ('rabbitmq', this.rmq),
    ]);
  }

  @Get('live')
  @HealthCheck()
  liveness() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
    ]);
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.deps.checkRabbitMQ('rabbitmq', this.rmq),
    ]);
  }
}

@Module({
  imports: [
    TerminusModule,
    JwtModule.register({
      secret: resolveJwtAccessSecret('notification-service'),
    }),
    RabbitMQModule.forRoot({
      serviceName: 'notification-service',
    }),
  ],
  controllers: [HealthController],
  providers: [
    DependencyHealthIndicator,
    InvoicePdfService,
    NotificationGateway,
    NotificationService,
  ],
})
export class NotificationModule {}
