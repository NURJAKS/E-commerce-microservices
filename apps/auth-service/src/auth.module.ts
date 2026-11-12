import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RabbitMQModule } from '@shop/rmq';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    JwtModule.register({
      secret:
        process.env.JWT_ACCESS_SECRET ||
        'super-secret-jwt-access-key-shop-2026',
      signOptions: {
        expiresIn: (process.env.JWT_ACCESS_EXPIRES_IN || '15m') as any,
      },
    }),
    RabbitMQModule.forRoot({
      serviceName: 'auth-service',
    }),
  ],
  controllers: [AuthController],
  providers: [PrismaService, AuthService],
})
export class AuthModule {}
