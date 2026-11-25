import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TerminusModule } from '@nestjs/terminus';
import {
  DependencyHealthIndicator,
  resolveJwtAccessSecret,
} from '@shop/common';
import { RabbitMQModule } from '@shop/rmq';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { HealthController } from './health.controller';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    TerminusModule,
    JwtModule.register({
      secret: resolveJwtAccessSecret('auth-service'),
      signOptions: {
        expiresIn: (process.env.JWT_ACCESS_EXPIRES_IN || '15m') as any,
      },
    }),
    RabbitMQModule.forRoot({
      serviceName: 'auth-service',
    }),
  ],
  controllers: [AuthController, HealthController],
  providers: [DependencyHealthIndicator, PrismaService, AuthService],
})
export class AuthModule {}
