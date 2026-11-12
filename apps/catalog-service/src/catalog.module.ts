import { Module } from '@nestjs/common';
import { RabbitMQModule } from '@shop/rmq';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    RabbitMQModule.forRoot({
      serviceName: 'catalog-service',
    }),
  ],
  controllers: [CatalogController],
  providers: [PrismaService, CatalogService],
})
export class CatalogModule {}
