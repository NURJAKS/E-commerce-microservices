import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '@shop/common';
import { CurrentUserPayload, JwtPayload } from '@shop/contracts';
import { SecurityRedisService } from '../security-redis.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SecurityRedisService)
    private readonly securityRedis: SecurityRedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const url: string = request.url || '';

    // Always allow healthcheck endpoint
    if (url.startsWith('/api/health')) {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      const optionalAuth: string | undefined = request.headers['authorization'];
      if (optionalAuth && optionalAuth.startsWith('Bearer ')) {
        try {
          const payload = await this.jwtService.verifyAsync<JwtPayload>(
            optionalAuth.slice(7).trim(),
          );
          if (
            !payload.jti ||
            !(await this.securityRedis.isAccessTokenBlacklisted(payload.jti))
          ) {
            request.user = {
              userId: payload.sub,
              email: payload.email,
              role: payload.role,
              jti: payload.jti,
              exp: payload.exp,
              traceId: request.headers['x-trace-id'],
            } as CurrentUserPayload;
          }
        } catch {
          // Ignore invalid token on public endpoints
        }
      }
      return true;
    }

    const authHeader: string | undefined = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7).trim();
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // Check Redis JWT Blacklist (jwt_blacklist:<jti>)
    if (
      payload.jti &&
      (await this.securityRedis.isAccessTokenBlacklisted(payload.jti))
    ) {
      throw new UnauthorizedException('Access token has been revoked');
    }

    const currentUser: CurrentUserPayload = {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
      jti: payload.jti,
      exp: payload.exp,
      traceId: request.headers['x-trace-id'],
    };

    request.user = currentUser;
    request.headers['x-user-id'] = currentUser.userId;
    request.headers['x-user-role'] = currentUser.role;
    request.headers['x-user-email'] = currentUser.email;
    return true;
  }
}
