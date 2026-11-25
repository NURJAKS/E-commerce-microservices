import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { DependencyHealthIndicator } from '@shop/common';
import { RabbitMQService } from '@shop/rmq';
import { CatalogService } from './catalog.service';
import { PrismaService } from './prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly deps: DependencyHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly catalogService: CatalogService,
    private readonly rmq: RabbitMQService,
  ) {}

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
      () => this.deps.checkPrisma('postgres', this.prisma),
      () =>
        this.deps.checkRedis('redis', () => this.catalogService.pingRedis()),
      () => this.deps.checkRabbitMQ('rabbitmq', this.rmq),
    ]);
  }
}
