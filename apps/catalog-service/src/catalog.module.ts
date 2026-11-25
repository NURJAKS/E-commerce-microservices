import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DependencyHealthIndicator } from '@shop/common';
import { RabbitMQModule } from '@shop/rmq';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { HealthController } from './health.controller';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    TerminusModule,
    RabbitMQModule.forRoot({
      serviceName: 'catalog-service',
    }),
  ],
  controllers: [CatalogController, HealthController],
  providers: [DependencyHealthIndicator, PrismaService, CatalogService],
})
export class CatalogModule {}
