import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@shop/contracts';
import { AuthService } from './auth.service';

describe('AuthService — Argon2id Password Hashing, JWT (with jti) & Refresh Rotation', () => {
  let authService: AuthService;
  let jwtService: JwtService;
  let mockPrisma: any;
  let mockRmqService: any;

  beforeEach(() => {
    jwtService = new JwtService({
      secret: 'test-jwt-secret-key',
      signOptions: { expiresIn: '15m' },
    });

    mockPrisma = {
      user: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      refreshToken: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    };

    mockRmqService = {
      publish: vi.fn().mockResolvedValue(true),
    };

    authService = new AuthService(mockPrisma, jwtService, mockRmqService);
  });

  it('hashes and verifies passwords using Argon2id', async () => {
    const rawPassword = 'SecurePassword123!';
    const hash = await authService.hashPassword(rawPassword);

    expect(hash).toContain('$argon2id$');
    await expect(authService.verifyPassword(rawPassword, hash)).resolves.toBe(
      true,
    );
    await expect(
      authService.verifyPassword('WrongPassword', hash),
    ).resolves.toBe(false);
  });

  it('registers a new user, embeds a unique jti in the JWT access token, and publishes user.registered', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockImplementation(({ data }: any) =>
      Promise.resolve({
        id: 'user-uuid-100',
        email: data.email,
        passwordHash: data.passwordHash,
        role: data.role,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    );
    mockPrisma.refreshToken.create.mockResolvedValue({ id: 'rt-1' });

    const response = await authService.register({
      email: 'NewUser@Example.com',
      password: 'Password123!',
    });

    expect(response.user.email).toBe('newuser@example.com');
    expect(response.user.role).toBe(UserRole.CUSTOMER);
    expect(response.accessToken).toBeTruthy();
    expect(response.refreshToken).toHaveLength(96);

    const decoded = await jwtService.verifyAsync(response.accessToken);
    expect(decoded.sub).toBe('user-uuid-100');
    expect(decoded.email).toBe('newuser@example.com');
    expect(decoded.jti).toBeTruthy();

    expect(mockRmqService.publish).toHaveBeenCalledWith(
      'user.registered',
      expect.objectContaining({
        userId: 'user-uuid-100',
        email: 'newuser@example.com',
      }),
    );
  });

  it('authenticates valid credentials via login and rejects invalid credentials', async () => {
    const hash = await authService.hashPassword('CorrectPass123!');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'login@example.com',
      passwordHash: hash,
      role: 'CUSTOMER',
      createdAt: new Date(),
    });
    mockPrisma.refreshToken.create.mockResolvedValue({ id: 'rt-2' });

    const loginRes = await authService.login({
      email: 'login@example.com',
      password: 'CorrectPass123!',
    });
    expect(loginRes.accessToken).toBeTruthy();

    await expect(
      authService.login({
        email: 'login@example.com',
        password: 'WrongPassword',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects duplicate registration with ConflictException', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'existing-id',
      email: 'taken@example.com',
    });

    await expect(
      authService.register({
        email: 'taken@example.com',
        password: 'Password123!',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('rotates refresh token by revoking the old token and issuing a fresh pair, and supports logout & getMe', async () => {
    const rawRefreshToken = 'sample-raw-refresh-token';
    const tokenHash = authService.hashRefreshToken(rawRefreshToken);

    mockPrisma.refreshToken.findUnique.mockResolvedValue({
      id: 'stored-rt-id',
      tokenHash,
      userId: 'user-uuid-100',
      revoked: false,
      expiresAt: new Date(Date.now() + 86400000),
      user: {
        id: 'user-uuid-100',
        email: 'user@example.com',
        role: 'CUSTOMER',
        createdAt: new Date(),
      },
    });
    mockPrisma.refreshToken.update.mockResolvedValue({});
    mockPrisma.refreshToken.create.mockResolvedValue({});

    const result = await authService.refreshTokens({
      refreshToken: rawRefreshToken,
    });

    expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'stored-rt-id' },
      data: { revoked: true },
    });
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).not.toBe(rawRefreshToken);

    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    const logoutRes = await authService.logout({
      refreshToken: result.refreshToken,
    });
    expect(logoutRes.success).toBe(true);

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-uuid-100',
      email: 'user@example.com',
      role: 'CUSTOMER',
      createdAt: new Date(),
    });
    const me = await authService.getMe('user-uuid-100');
    expect(me.email).toBe('user@example.com');

    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(authService.getMe('missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects revoked or expired refresh tokens with UnauthorizedException', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue({
      id: 'revoked-rt-id',
      revoked: true,
      expiresAt: new Date(Date.now() + 86400000),
    });

    await expect(
      authService.refreshTokens({ refreshToken: 'revoked-token' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
