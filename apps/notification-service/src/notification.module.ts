import { Controller, Get, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  TerminusModule,
} from '@nestjs/terminus';
import { RabbitMQModule } from '@shop/rmq';
import { NotificationGateway } from './notification.gateway';
import { NotificationService } from './notification.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
  ) {}

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
    JwtModule.register({
      secret:
        process.env.JWT_ACCESS_SECRET ||
        'super-secret-jwt-access-key-shop-2026',
    }),
    RabbitMQModule.forRoot({
      serviceName: 'notification-service',
    }),
  ],
  controllers: [HealthController],
  providers: [NotificationGateway, NotificationService],
})
export class NotificationModule {}
