import 'reflect-metadata';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { of } from 'rxjs';
import request from 'supertest';
import { HttpExceptionFilter } from '@shop/common';
import {
  AUTH_PATTERNS,
  CATALOG_PATTERNS,
  ORDER_PATTERNS,
  SERVICES,
  UserRole,
} from '@shop/contracts';
import { AuthGatewayController } from './controllers/auth.controller';
import { CatalogGatewayController } from './controllers/catalog.controller';
import { OrderGatewayController } from './controllers/order.controller';
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
        JwtModule.register({
          secret: 'test-gateway-jwt-secret',
          signOptions: { expiresIn: '15m' },
        }),
      ],
      controllers: [
        AuthGatewayController,
        CatalogGatewayController,
        OrderGatewayController,
      ],
      providers: [
        {
          provide: GATEWAY_REDIS_CLIENT,
          useValue: { status: 'end', quit: vi.fn() },
        },
        SecurityRedisService,
        IdempotencyInterceptor,
        {
          provide: MinioService,
          useValue: { uploadProductImage: vi.fn() },
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

    app = moduleRef.createNestApplication();
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
      .set('X-Forwarded-For', testIp)
      .send({ email: 'a@b.c', password: 'password123' });

    expect(sixthAttempt.status).toBe(429);
  });
});
