import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@shop/contracts';
import { AuthService } from './auth.service';
import { generateTotpToken } from './totp.util';

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
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      refreshToken: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
      role: UserRole.ADMIN,
    } as any);

    expect(response.user.email).toBe('newuser@example.com');
    // Security: privilege escalation via self-assigned ADMIN role is blocked
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

  it('detects Refresh Token Reuse on a revoked token and revokes the entire session family with JTIs', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue({
      id: 'revoked-rt-id',
      userId: 'user-reuse-1',
      familyId: 'fam-stolen-1',
      revoked: true,
      expiresAt: new Date(Date.now() + 86400000),
    });
    mockPrisma.refreshToken.findMany.mockResolvedValueOnce([
      { lastAccessJti: 'jti-active-1' },
      { lastAccessJti: 'jti-active-2' },
    ]);

    try {
      await authService.refreshTokens({ refreshToken: 'replayed-token' });
      expect.unreachable('Should throw UnauthorizedException');
    } catch (err: any) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      const res = err.getResponse();
      expect(res.reuseDetected).toBe(true);
      expect(res.revokedJtis).toEqual(['jti-active-1', 'jti-active-2']);
    }

    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'fam-stolen-1' },
      data: { revoked: true },
    });
  });

  it('lists active device sessions, enforces IDOR on session revocation, and revokes all devices', async () => {
    const rawCurrent = 'my-current-refresh-token';
    const currentHash = authService.hashRefreshToken(rawCurrent);

    mockPrisma.refreshToken.findMany.mockResolvedValueOnce([
      {
        id: 'sess-1',
        familyId: 'fam-1',
        tokenHash: currentHash,
        deviceName: 'Chrome on Linux',
        userAgent: 'Mozilla/5.0 Chrome/120.0 Linux',
        ipAddress: '10.0.0.1',
        createdAt: new Date(),
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      },
    ]);

    const sessions = await authService.getActiveSessions('user-1', rawCurrent);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].isCurrent).toBe(true);
    expect(sessions[0].deviceName).toBe('Chrome on Linux');

    // IDOR check: another user cannot revoke sess-1
    mockPrisma.refreshToken.findUnique.mockResolvedValueOnce({
      id: 'sess-1',
      userId: 'user-1',
      familyId: 'fam-1',
    });
    await expect(
      authService.revokeSession('attacker-2', 'sess-1'),
    ).rejects.toThrow(ForbiddenException);

    // Owner revokes single session family
    mockPrisma.refreshToken.findUnique.mockResolvedValueOnce({
      id: 'sess-1',
      userId: 'user-1',
      familyId: 'fam-1',
    });
    mockPrisma.refreshToken.findMany.mockResolvedValueOnce([
      { lastAccessJti: 'jti-sess-1' },
    ]);
    const revoked = await authService.revokeSession('user-1', 'sess-1');
    expect(revoked).toEqual({ success: true, revokedJtis: ['jti-sess-1'] });

    // Revoke all sessions
    mockPrisma.refreshToken.findMany.mockResolvedValueOnce([
      { lastAccessJti: 'jti-a' },
      { lastAccessJti: 'jti-b' },
    ]);
    mockPrisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 2 });
    const all = await authService.revokeAllSessions('user-1');
    expect(all).toEqual({
      success: true,
      revokedCount: 2,
      revokedJtis: ['jti-a', 'jti-b'],
    });
  });

  it('supports RFC 6238 TOTP 2FA setup, enable, login challenge, and disable', async () => {
    const hash = await authService.hashPassword('AdminPass123!');
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'admin-1',
      email: 'admin@shop.local',
      role: 'ADMIN',
      passwordHash: hash,
      totpEnabled: false,
      totpSecret: null,
      createdAt: new Date(),
    });
    mockPrisma.user.update.mockResolvedValue({});

    const setup = await authService.setupTwoFactor('admin-1');
    expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.otpauthUrl).toContain('otpauth://totp/');
    expect(setup.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

    // Security: TOTP secret persisted to DB must be AES-256-GCM encrypted, never plaintext Base32
    const persistedSecret = mockPrisma.user.update.mock.calls[0][0].data.totpSecret;
    expect(persistedSecret).toMatch(/^enc:v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(persistedSecret).not.toContain(setup.secret);

    const validCode = generateTotpToken(setup.secret);

    // Reject bad code on enable
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'admin-1',
      totpSecret: persistedSecret,
      totpEnabled: false,
    });
    await expect(
      authService.enableTwoFactor('admin-1', '000000'),
    ).rejects.toThrow(BadRequestException);

    // Accept valid code on enable
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'admin-1',
      totpSecret: persistedSecret,
      totpEnabled: false,
    });
    const enabled = await authService.enableTwoFactor('admin-1', validCode);
    expect(enabled.totpEnabled).toBe(true);

    // Login without totpCode returns 2FA_REQUIRED
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@shop.local',
      role: 'ADMIN',
      passwordHash: hash,
      totpEnabled: true,
      totpSecret: persistedSecret,
      createdAt: new Date(),
    });
    await expect(
      authService.login({
        email: 'admin@shop.local',
        password: 'AdminPass123!',
      }),
    ).rejects.toThrow('2FA_REQUIRED');

    // Login with valid totpCode succeeds
    mockPrisma.refreshToken.create.mockResolvedValue({ id: 'rt-2fa' });
    const loggedIn = await authService.login({
      email: 'admin@shop.local',
      password: 'AdminPass123!',
      totpCode: validCode,
    });
    expect(loggedIn.accessToken).toBeTruthy();

    // Disable 2FA with valid code
    const disabled = await authService.disableTwoFactor('admin-1', validCode);
    expect(disabled.totpEnabled).toBe(false);
  });

  it('registers new users and links existing accounts via Google OAuth 2.0', async () => {
    // 1. New Google user
    mockPrisma.user.findFirst.mockResolvedValueOnce(null);
    mockPrisma.user.create.mockResolvedValueOnce({
      id: 'google-user-1',
      email: 'alex@gmail.com',
      role: 'CUSTOMER',
      authProvider: 'GOOGLE',
      googleId: 'g-sub-123',
      avatarUrl: 'https://lh3.googleusercontent.com/pic.png',
      totpEnabled: false,
      createdAt: new Date(),
    });
    mockPrisma.refreshToken.create.mockResolvedValue({ id: 'rt-g-1' });

    const newRes = await authService.loginWithGoogle(
      {
        googleId: 'g-sub-123',
        email: 'Alex@Gmail.com',
        avatarUrl: 'https://lh3.googleusercontent.com/pic.png',
      },
      { userAgent: 'Chrome/120 macOS', ipAddress: '1.2.3.4' },
    );

    expect(newRes.user.authProvider).toBe('GOOGLE');
    expect(mockRmqService.publish).toHaveBeenCalledWith(
      'user.registered',
      expect.objectContaining({ email: 'alex@gmail.com' }),
    );

    // 2. Existing LOCAL user linked to HYBRID
    mockRmqService.publish.mockClear();
    mockPrisma.user.findFirst.mockResolvedValueOnce({
      id: 'local-user-2',
      email: 'existing@gmail.com',
      passwordHash: '$argon2id$...',
      role: 'CUSTOMER',
      authProvider: 'LOCAL',
      googleId: null,
      avatarUrl: null,
      createdAt: new Date(),
    });
    mockPrisma.user.update.mockResolvedValueOnce({
      id: 'local-user-2',
      email: 'existing@gmail.com',
      role: 'CUSTOMER',
      authProvider: 'HYBRID',
      googleId: 'g-sub-456',
      avatarUrl: 'https://pic',
      createdAt: new Date(),
    });

    const linkedRes = await authService.loginWithGoogle({
      googleId: 'g-sub-456',
      email: 'existing@gmail.com',
      avatarUrl: 'https://pic',
    });

    expect(linkedRes.user.authProvider).toBe('HYBRID');
    expect(mockRmqService.publish).not.toHaveBeenCalled();
  });
});
