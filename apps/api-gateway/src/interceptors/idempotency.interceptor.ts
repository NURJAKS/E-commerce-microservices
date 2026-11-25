import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { SecurityRedisService } from '../security-redis.service';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    @Inject(SecurityRedisService)
    private readonly securityRedis: SecurityRedisService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const idempotencyKey = (
      request.headers['x-idempotency-key'] as string | undefined
    )?.trim();

    if (!idempotencyKey) {
      return next.handle();
    }

    const userId = request.user?.userId || request.ip || 'anonymous';
    // Atomic SET NX EX eliminates TOCTOU races between concurrent retries with the same X-Idempotency-Key
    const acquired = await this.securityRedis.acquireIdempotencyLock(
      userId,
      idempotencyKey,
    );

    if (!acquired) {
      const existing = await this.securityRedis.getIdempotencyRecord(
        userId,
        idempotencyKey,
      );

      // Replay cached response for 24h to guarantee idempotency across network retries / double-clicks
      if (existing && existing.status === 'COMPLETED') {
        this.logger.log(
          `[Idempotency] Replaying cached response for user=${userId} key=${idempotencyKey}`,
        );
        if (response && typeof response.setHeader === 'function') {
          response.setHeader('X-Idempotency-Replayed', 'true');
        }
        return of(existing.response);
      }

      // Block concurrent in-flight retries before the first transaction finishes
      throw new ConflictException(
        'A request with this X-Idempotency-Key is currently being processed',
      );
    }

    return next.handle().pipe(
      tap(async (data) => {
        await this.securityRedis.completeIdempotencyKey(
          userId,
          idempotencyKey,
          data,
        );
      }),
      catchError(async (err) => {
        // Release the lock on failure so legitimate retries with the same key are not permanently blocked
        await this.securityRedis.releaseIdempotencyKey(userId, idempotencyKey);
        throw err;
      }),
    );
  }
}
