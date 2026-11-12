import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import Redis from 'ioredis';

export const GATEWAY_REDIS_CLIENT = 'GATEWAY_REDIS_CLIENT';
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export interface IdempotencyRecord {
  status: 'PROCESSING' | 'COMPLETED';
  response?: any;
  createdAt: string;
}

@Injectable()
export class SecurityRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SecurityRedisService.name);
  private readonly redis: Redis;
  private readonly fallbackMemory = new Map<
    string,
    { value: string; expiresAt: number }
  >();

  constructor(@Optional() @Inject(GATEWAY_REDIS_CLIENT) redisClient?: Redis) {
    this.redis =
      redisClient ||
      new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
        lazyConnect: true,
      });
  }

  async onModuleInit(): Promise<void> {
    if (this.redis.status === 'wait') {
      try {
        await this.redis.connect();
      } catch (err: any) {
        this.logger.warn(
          `Gateway Redis connection warning (using in-memory fallback): ${err?.message || err}`,
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // Ignore
    }
  }

  // ==========================================
  // 1. JWT Blacklisting (jwt_blacklist:<jti>)
  // ==========================================

  async blacklistAccessToken(jti: string, ttlSeconds = 900): Promise<void> {
    if (!jti) return;
    const key = `jwt_blacklist:${jti}`;
    const safeTtl = Math.max(1, Math.ceil(ttlSeconds));
    await this.setWithTtl(key, 'revoked', safeTtl);
    this.logger.log(
      `[Security] Blacklisted JWT access token jti=${jti} for ${safeTtl}s`,
    );
  }

  async isAccessTokenBlacklisted(jti?: string): Promise<boolean> {
    if (!jti) return false;
    const val = await this.getVal(`jwt_blacklist:${jti}`);
    return val !== null;
  }

  // ==========================================
  // 2. API Idempotency (idempotency:<userId>:<key>)
  // ==========================================

  async getIdempotencyRecord(
    userId: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | null> {
    const key = `idempotency:${userId}:${idempotencyKey}`;
    const raw = await this.getVal(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IdempotencyRecord;
    } catch {
      return null;
    }
  }

  async lockIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<void> {
    const key = `idempotency:${userId}:${idempotencyKey}`;
    const record: IdempotencyRecord = {
      status: 'PROCESSING',
      createdAt: new Date().toISOString(),
    };
    await this.setWithTtl(key, JSON.stringify(record), 60);
  }

  async completeIdempotencyKey(
    userId: string,
    idempotencyKey: string,
    response: any,
  ): Promise<void> {
    const key = `idempotency:${userId}:${idempotencyKey}`;
    const record: IdempotencyRecord = {
      status: 'COMPLETED',
      response,
      createdAt: new Date().toISOString(),
    };
    await this.setWithTtl(
      key,
      JSON.stringify(record),
      IDEMPOTENCY_TTL_SECONDS,
    );
  }

  async releaseIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<void> {
    const key = `idempotency:${userId}:${idempotencyKey}`;
    try {
      if (this.redis.status === 'ready') {
        await this.redis.del(key);
      }
    } catch {
      // Ignore
    }
    this.fallbackMemory.delete(key);
  }

  // ==========================================
  // 3. Rate Limiting / WAF Counter
  // ==========================================

  async incrementRateLimit(
    bucketKey: string,
    windowSeconds: number,
  ): Promise<number> {
    const key = `ratelimit:${bucketKey}`;
    try {
      if (this.redis.status === 'ready') {
        const count = await this.redis.incr(key);
        if (count === 1) {
          await this.redis.expire(key, windowSeconds);
        }
        return count;
      }
    } catch {
      // Fallback to memory
    }

    const now = Date.now();
    const existing = this.fallbackMemory.get(key);
    if (!existing || existing.expiresAt < now) {
      this.fallbackMemory.set(key, {
        value: '1',
        expiresAt: now + windowSeconds * 1000,
      });
      return 1;
    }
    const nextCount = Number(existing.value) + 1;
    existing.value = String(nextCount);
    return nextCount;
  }

  private async setWithTtl(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    this.fallbackMemory.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    try {
      if (this.redis.status === 'ready') {
        await this.redis.set(key, value, 'EX', ttlSeconds);
      }
    } catch {
      // Fallback memory already updated
    }
  }

  private async getVal(key: string): Promise<string | null> {
    try {
      if (this.redis.status === 'ready') {
        const val = await this.redis.get(key);
        if (val !== null) return val;
      }
    } catch {
      // Fallback to memory
    }

    const mem = this.fallbackMemory.get(key);
    if (!mem) return null;
    if (mem.expiresAt < Date.now()) {
      this.fallbackMemory.delete(key);
      return null;
    }
    return mem.value;
  }
}
