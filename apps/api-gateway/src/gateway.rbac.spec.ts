import 'reflect-metadata';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { TerminusModule } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { DependencyHealthIndicator, HttpExceptionFilter } from '@shop/common';
import {
  AUTH_PATTERNS,
  CATALOG_PATTERNS,
  ORDER_PATTERNS,
  PAYMENT_PATTERNS,
  SERVICES,
  UserRole,
} from '@shop/contracts';
import { AuthGatewayController } from './controllers/auth.controller';
import { CatalogGatewayController } from './controllers/catalog.controller';
import { OrderGatewayController } from './controllers/order.controller';
import { HealthGatewayController } from './gateway.module';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { WafThrottlerGuard } from './guards/waf-throttler.guard';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor';
import { MinioService } from './minio.service';
import {
  GATEWAY_REDIS_CLIENT,
  SecurityRedisService,
} from './security-redis.service';

describe('API Gateway Integration Tests (Supertest: RBAC, HttpOnly Cookie, JWT Blacklist, Idempotency & WAF)', () => {
  let app: INestApplication;
  let jwtService: JwtService;
  let mockAuthClient: { send: ReturnType<typeof vi.fn> };
  let mockCatalogClient: { send: ReturnType<typeof vi.fn> };
  let mockOrderClient: { send: ReturnType<typeof vi.fn> };
  let mockPaymentClient: { send: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mockAuthClient = { send: vi.fn() };
    mockCatalogClient = { send: vi.fn() };
    mockOrderClient = { send: vi.fn() };
    mockPaymentClient = { send: vi.fn() };

    const moduleRef = await Test.createTestingModule({
      imports: [
        TerminusModule,
        JwtModule.register({
          secret: 'test-gateway-jwt-secret',
          signOptions: { expiresIn: '15m' },
        }),
      ],
      controllers: [
        HealthGatewayController,
        AuthGatewayController,
        CatalogGatewayController,
        OrderGatewayController,
      ],
      providers: [
        DependencyHealthIndicator,
        {
          provide: GATEWAY_REDIS_CLIENT,
          useValue: {
            status: 'end',
            ping: vi.fn().mockResolvedValue('PONG'),
            quit: vi.fn(),
          },
        },
        SecurityRedisService,
        IdempotencyInterceptor,
        {
          provide: MinioService,
          useValue: {
            uploadProductImage: vi.fn(),
            createPresignedUploadUrl: vi.fn().mockResolvedValue({
              uploadUrl: 'http://localhost:9000/products-media/products/test.webp?X-Amz-Signature=abc',
              key: 'products/test.webp',
              publicUrl: 'http://localhost:9000/products-media/products/test.webp',
              expiresInSeconds: 60,
              requiredHeaders: { 'Content-Type': 'image/webp' },
            }),
          },
        },
        { provide: SERVICES.AUTH, useValue: mockAuthClient },
        { provide: SERVICES.CATALOG, useValue: mockCatalogClient },
        { provide: SERVICES.ORDER, useValue: mockOrderClient },
        { provide: SERVICES.PAYMENT, useValue: mockPaymentClient },
        { provide: APP_GUARD, useClass: WafThrottlerGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    (app as any).set('trust proxy', 1);
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    jwtService = moduleRef.get(JwtService);
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects CUSTOMER role with 403 Forbidden on ADMIN-protected endpoint (POST /api/catalog/products)', async () => {
    const customerToken = await jwtService.signAsync({
      sub: 'cust-1',
      email: 'customer@shop.local',
      role: UserRole.CUSTOMER,
      jti: 'jti-customer-1',
    });

    const res = await request(app.getHttpServer())
      .post('/api/catalog/products')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        title: 'Unauthorized Product',
        description: 'Should be blocked by RolesGuard',
        price: 99,
        stock: 10,
        categoryId: 'cat-1',
      });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('Access denied');
    expect(mockCatalogClient.send).not.toHaveBeenCalled();
  });

  it('allows ADMIN role (201 Created) on ADMIN-protected endpoint (POST /api/catalog/products)', async () => {
    const adminToken = await jwtService.signAsync({
      sub: 'admin-1',
      email: 'admin@shop.local',
      role: UserRole.ADMIN,
      jti: 'jti-admin-1',
    });

    mockCatalogClient.send.mockImplementation((pattern: string) => {
      if (pattern === CATALOG_PATTERNS.CREATE_PRODUCT) {
        return of({
          id: 'prod-new-1',
          title: 'Pro Admin Product',
          price: 299,
          stock: 15,
        });
      }
      return of({});
    });

    const res = await request(app.getHttpServer())
      .post('/api/catalog/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Pro Admin Product',
        description: 'Created by admin',
        price: 299,
        stock: 15,
        categoryId: 'cat-1',
      });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Pro Admin Product');
  });

  it('sets HttpOnly SameSite=Strict refresh_token cookie on login and blacklists JWT jti on logout', async () => {
    const accessToken = await jwtService.signAsync({
      sub: 'user-99',
      email: 'user99@shop.local',
      role: UserRole.CUSTOMER,
      jti: 'jti-blacklist-test-99',
    });

    mockAuthClient.send.mockImplementation((pattern: string) => {
      if (pattern === AUTH_PATTERNS.LOGIN) {
        return of({
          user: {
            id: 'user-99',
            email: 'user99@shop.local',
            role: UserRole.CUSTOMER,
            createdAt: new Date().toISOString(),
          },
          accessToken,
          refreshToken: 'secret-refresh-token-value',
        });
      }
      if (pattern === AUTH_PATTERNS.LOGOUT) {
        return of({ success: true });
      }
      if (pattern === AUTH_PATTERNS.ME) {
        return of({
          id: 'user-99',
          email: 'user99@shop.local',
          role: UserRole.CUSTOMER,
        });
      }
      return of({});
    });

    const loginRes = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'user99@shop.local', password: 'StrongPass123!' });

    expect(loginRes.status).toBe(201);
    const setCookieHeader = loginRes.headers['set-cookie']?.[0] || '';
    expect(setCookieHeader).toContain('refresh_token=secret-refresh-token-value');
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('SameSite=Strict');

    // Token works before logout
    const meBefore = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(meBefore.status).toBe(200);

    // Logout blacklists the JWT jti in Redis
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    // Reusing the same Access Token after logout is blocked by JwtAuthGuard (401)
    const meAfter = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(meAfter.status).toBe(401);
    expect(meAfter.body.message).toContain('revoked');
  });

  it('enforces X-Idempotency-Key on POST /api/orders/checkout so duplicate clicks return the cached order without charging twice', async () => {
    const customerToken = await jwtService.signAsync({
      sub: 'cust-idem-1',
      email: 'idem@shop.local',
      role: UserRole.CUSTOMER,
      jti: 'jti-idem-1',
    });

    mockOrderClient.send.mockImplementation((pattern: string) => {
      if (pattern === ORDER_PATTERNS.CHECKOUT) {
        return of({
          id: 'order-idem-123',
          userId: 'cust-idem-1',
          status: 'PENDING',
          totalAmount: 151.2,
          items: [],
        });
      }
      return of({});
    });

    const idemKey = '11111111-2222-3333-4444-555555555555';

    const firstAttempt = await request(app.getHttpServer())
      .post('/api/orders/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('X-Idempotency-Key', idemKey)
      .send({ discountCode: 'WELCOME20' });

    expect(firstAttempt.status).toBe(201);
    expect(firstAttempt.body.id).toBe('order-idem-123');

    const secondAttempt = await request(app.getHttpServer())
      .post('/api/orders/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('X-Idempotency-Key', idemKey)
      .send({ discountCode: 'WELCOME20' });

    expect(secondAttempt.status).toBe(201);
    expect(secondAttempt.headers['x-idempotency-replayed']).toBe('true');
    expect(secondAttempt.body.id).toBe('order-idem-123');
    // Underlying OrderService RPC was only called ONCE
    expect(mockOrderClient.send).toHaveBeenCalledTimes(1);
  });

  it('enforces WAF brute-force rate limit (max 5 attempts/min per IP) on POST /api/auth/login', async () => {
    mockAuthClient.send.mockReturnValue(
      of({
        user: { id: 'u-1', email: 'a@b.c', role: UserRole.CUSTOMER },
        accessToken: 'tok',
        refreshToken: 'ref',
      }),
    );

    const testIp = '203.0.113.77';
    for (let i = 1; i <= 5; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('X-Forwarded-For', testIp)
        .send({ email: 'a@b.c', password: 'password123' });
      expect(res.status).toBe(201);
    }

    const sixthAttempt = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Forwarded-For', `198.51.100.99, ${testIp}`)
      .send({ email: 'a@b.c', password: 'password123' });

    // Even with a spoofed leading X-Forwarded-For IP, trust proxy=1 resolves the proxy-appended IP and enforces 429
    expect(sixthAttempt.status).toBe(429);
  });

  it('exposes public /api/health/live and /api/health/ready endpoints verifying Redis connectivity', async () => {
    const liveRes = await request(app.getHttpServer()).get('/api/health/live');
    expect(liveRes.status).toBe(200);
    expect(liveRes.body.status).toBe('ok');

    const readyRes = await request(app.getHttpServer()).get('/api/health/ready');
    expect(readyRes.status).toBe(200);
    expect(readyRes.body.status).toBe('ok');
    expect(readyRes.body.info.redis.status).toBe('up');
  });

  it('restricts POST /api/catalog/upload/presign to ADMIN and issues a 60s Presigned PUT URL', async () => {
    const customerToken = await jwtService.signAsync({
      sub: 'cust-presign',
      email: 'cust@shop.local',
      role: UserRole.CUSTOMER,
      jti: 'jti-cust-presign',
    });
    const adminToken = await jwtService.signAsync({
      sub: 'admin-presign',
      email: 'admin@shop.local',
      role: UserRole.ADMIN,
      jti: 'jti-admin-presign',
    });

    const forbidden = await request(app.getHttpServer())
      .post('/api/catalog/upload/presign')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ fileName: 'a.webp', contentType: 'image/webp', sizeBytes: 5000 });
    expect(forbidden.status).toBe(403);

    const allowed = await request(app.getHttpServer())
      .post('/api/catalog/upload/presign')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fileName: 'a.webp', contentType: 'image/webp', sizeBytes: 5000 });
    expect(allowed.status).toBe(201);
    expect(allowed.body.expiresInSeconds).toBe(60);
    expect(allowed.body.key).toBe('products/test.webp');
  });

  it('forwards exact raw body & Stripe-Signature to payment-service on public POST /api/payments/webhook/stripe', async () => {
    const missingSig = await request(app.getHttpServer())
      .post('/api/payments/webhook/stripe')
      .send({ id: 'evt_no_sig' });
    expect(missingSig.status).toBe(400);

    mockPaymentClient.send.mockReturnValueOnce(
      of({ received: true, deduplicated: false, eventId: 'evt_gw_1' }),
    );

    const rawPayload = '{"id":"evt_gw_1","type":"checkout.session.completed"}';
    const res = await request(app.getHttpServer())
      .post('/api/payments/webhook/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=1700000000,v1=test_sig')
      .send(rawPayload);

    expect(res.status).toBe(201);
    expect(res.body.received).toBe(true);
    expect(mockPaymentClient.send).toHaveBeenCalledWith(
      PAYMENT_PATTERNS.HANDLE_STRIPE_WEBHOOK,
      expect.objectContaining({
        rawBody: rawPayload,
        signature: 't=1700000000,v1=test_sig',
      }),
    );
  });

  it('blacklists revoked session-family JTIs in Redis when Refresh Token Reuse Detection triggers and redirects Google OAuth with CSRF state cookie', async () => {
    const activeToken = await jwtService.signAsync({
      sub: 'victim-1',
      email: 'victim@shop.local',
      role: UserRole.CUSTOMER,
      jti: 'jti-stolen-family-1',
    });

    mockAuthClient.send.mockImplementation((pattern: string) => {
      if (pattern === AUTH_PATTERNS.REFRESH) {
        return throwError(() => ({
          statusCode: 401,
          message: 'Refresh token reuse detected — session family revoked',
          reuseDetected: true,
          revokedJtis: ['jti-stolen-family-1'],
        }));
      }
      return of({});
    });

    const reuseRes = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: 'replayed-refresh-token' });
    expect(reuseRes.status).toBe(401);

    // The active JWT belonging to the compromised family is now immediately blacklisted in Redis
    const blockedMe = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${activeToken}`);
    expect(blockedMe.status).toBe(401);
    expect(blockedMe.body.message).toContain('revoked');

    // Google OAuth 2.0 initiation sets CSRF state cookie & redirects to accounts.google.com
    process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
    const oauthRes = await request(app.getHttpServer()).get('/api/auth/google');
    expect(oauthRes.status).toBe(302);
    expect(oauthRes.headers.location).toContain(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(oauthRes.headers['set-cookie']?.[0]).toContain('oauth_state=');
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  it('rejects concurrent in-flight duplicate X-Idempotency-Key with 409 Conflict via atomic lock', async () => {
    const customerToken = await jwtService.signAsync({
      sub: 'cust-race-1',
      email: 'race@shop.local',
      role: UserRole.CUSTOMER,
      jti: 'jti-race-1',
    });

    const securityRedis = app.get(SecurityRedisService);
    const raceKey = 'race-lock-key-001';
    const firstAcquired = await securityRedis.acquireIdempotencyLock(
      'cust-race-1',
      raceKey,
    );
    const secondAcquired = await securityRedis.acquireIdempotencyLock(
      'cust-race-1',
      raceKey,
    );
    expect(firstAcquired).toBe(true);
    expect(secondAcquired).toBe(false);

    const conflictRes = await request(app.getHttpServer())
      .post('/api/orders/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('X-Idempotency-Key', raceKey)
      .send({});
    expect(conflictRes.status).toBe(409);
    expect(mockOrderClient.send).not.toHaveBeenCalled();
  });
});
