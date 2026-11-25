import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { SecurityRedisService } from '../security-redis.service';

@Injectable()
export class WafThrottlerGuard implements CanActivate {
  private readonly logger = new Logger(WafThrottlerGuard.name);

  constructor(
    @Inject(SecurityRedisService)
    private readonly securityRedis: SecurityRedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env.DISABLE_RATE_LIMIT === 'true') {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    // Express resolves `request.ip` safely using `trust proxy = 1` (single Nginx hop), blocking client X-Forwarded-For spoofing
    const ip =
      request.ip || request.socket?.remoteAddress || '127.0.0.1';
    const path: string = request.url || '';
    const method: string = request.method || 'GET';

    const isAuthLoginEndpoint =
      method === 'POST' && path.includes('/auth/login');

    const limit = isAuthLoginEndpoint ? 5 : 300;
    const windowSeconds = 60;
    const bucketKey = isAuthLoginEndpoint
      ? `auth:${ip}`
      : `global:${ip}`;

    const currentCount = await this.securityRedis.incrementRateLimit(
      bucketKey,
      windowSeconds,
    );

    if (response && typeof response.setHeader === 'function') {
      response.setHeader('X-RateLimit-Limit', String(limit));
      response.setHeader(
        'X-RateLimit-Remaining',
        String(Math.max(0, limit - currentCount)),
      );
    }

    if (currentCount > limit) {
      this.logger.warn(
        `[WAF Anomaly Detected] Rate limit exceeded (${currentCount}/${limit} req/min) from IP=${ip} on ${method} ${path}`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            'Too many requests from this IP, please try again after 1 minute.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
