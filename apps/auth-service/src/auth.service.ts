import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import * as QRCode from 'qrcode';
import {
  AuthTokensResponse,
  JwtPayload,
  LoginDto,
  RefreshTokenDto,
  RegisterDto,
  SessionDto,
  SessionMetadata,
  TotpSetupResponse,
  UserDto,
  UserRegisteredEvent,
  UserRole,
} from '@shop/contracts';
import { RabbitMQService, ROUTING_KEYS } from '@shop/rmq';
import { PrismaService } from './prisma.service';
import {
  buildOtpAuthUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateBase32Secret,
  parseDeviceName,
  verifyTotpToken,
} from './totp.util';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly refreshTtlDays = Number(
    process.env.JWT_REFRESH_TTL_DAYS || 7,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly rmqService: RabbitMQService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedDefaultAdmin();
    } catch (err: any) {
      this.logger.warn(
        `Skipping default admin seed until database is ready: ${err?.message || err}`,
      );
    }
  }

  private async seedDefaultAdmin(): Promise<void> {
    if (
      process.env.NODE_ENV === 'production' &&
      process.env.SEED_DEFAULT_ADMIN !== 'true'
    ) {
      return;
    }
    const adminEmail = (
      process.env.DEFAULT_ADMIN_EMAIL || 'admin@shop.local'
    )
      .trim()
      .toLowerCase();
    const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'AdminPass123!';
    const existing = await this.prisma.user.findUnique({
      where: { email: adminEmail },
    });
    if (!existing) {
      const passwordHash = await this.hashPassword(adminPassword);
      await this.prisma.user.create({
        data: {
          email: adminEmail,
          passwordHash,
          role: 'ADMIN',
        },
      });
      this.logger.log(`Seeded default admin account: ${adminEmail}`);
    }
  }

  async hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  hashRefreshToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  async register(
    dto: RegisterDto,
    meta?: SessionMetadata,
  ): Promise<AuthTokensResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ConflictException('User with this email already exists');
    }

    const passwordHash = await this.hashPassword(dto.password);
    // Security: public registration ALWAYS assigns CUSTOMER role, never trusting client-supplied privileges
    const role = UserRole.CUSTOMER;

    const user = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        role,
        authProvider: 'LOCAL',
      },
    });

    const tokens = await this.issueTokenPair(
      user.id,
      user.email,
      user.role as UserRole,
      { userAgent: meta?.userAgent, ipAddress: meta?.ipAddress },
    );

    const eventPayload: UserRegisteredEvent = {
      userId: user.id,
      email: user.email,
      role: user.role as UserRole,
      registeredAt: user.createdAt.toISOString(),
    };
    await this.rmqService.publish(ROUTING_KEYS.USER_REGISTERED, eventPayload);

    return {
      user: this.toUserDto(user),
      ...tokens,
    };
  }

  async login(
    dto: LoginDto,
    meta?: SessionMetadata,
  ): Promise<AuthTokensResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await this.verifyPassword(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Enforce optional 2FA (TOTP via Google Authenticator)
    if (user.totpEnabled && user.totpSecret) {
      if (!dto.totpCode) {
        throw new UnauthorizedException('2FA_REQUIRED');
      }
      const plainSecret = decryptTotpSecret(user.totpSecret);
      if (!verifyTotpToken(plainSecret, dto.totpCode)) {
        throw new UnauthorizedException('Invalid 2FA authenticator code');
      }
    }

    const tokens = await this.issueTokenPair(
      user.id,
      user.email,
      user.role as UserRole,
      { userAgent: meta?.userAgent, ipAddress: meta?.ipAddress },
    );

    return {
      user: this.toUserDto(user),
      ...tokens,
    };
  }

  /**
   * Google OAuth 2.0 Sign-In / Sign-Up:
   * Links an existing email account or creates a new passwordless Google account.
   */
  async loginWithGoogle(
    profile: {
      googleId: string;
      email: string;
      avatarUrl?: string;
    },
    meta?: SessionMetadata,
  ): Promise<AuthTokensResponse> {
    const normalizedEmail = profile.email.trim().toLowerCase();
    let user = await this.prisma.user.findFirst({
      where: {
        OR: [{ googleId: profile.googleId }, { email: normalizedEmail }],
      },
    });

    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      user = await this.prisma.user.create({
        data: {
          email: normalizedEmail,
          passwordHash: null,
          role: 'CUSTOMER',
          authProvider: 'GOOGLE',
          googleId: profile.googleId,
          avatarUrl: profile.avatarUrl || null,
        },
      });
    } else if (!user.googleId) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: profile.googleId,
          avatarUrl: profile.avatarUrl || user.avatarUrl,
          authProvider: user.passwordHash ? 'HYBRID' : 'GOOGLE',
        },
      });
    }

    const tokens = await this.issueTokenPair(
      user.id,
      user.email,
      user.role as UserRole,
      { userAgent: meta?.userAgent, ipAddress: meta?.ipAddress },
    );

    if (isNewUser) {
      const eventPayload: UserRegisteredEvent = {
        userId: user.id,
        email: user.email,
        role: user.role as UserRole,
        registeredAt: user.createdAt.toISOString(),
      };
      await this.rmqService.publish(ROUTING_KEYS.USER_REGISTERED, eventPayload);
    }

    return {
      user: this.toUserDto(user),
      ...tokens,
    };
  }

  /**
   * Refresh Token Rotation with Reuse Detection:
   * Every refresh rotates within the same `familyId`. If a previously revoked token is replayed,
   * the entire token family is immediately revoked and all active `jti`s are returned for Redis blacklisting.
   */
  async refreshTokens(
    dto: RefreshTokenDto,
    meta?: SessionMetadata,
  ): Promise<AuthTokensResponse> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!storedToken) {
      throw new UnauthorizedException('Invalid or revoked refresh token');
    }

    // Reuse Detection: replaying an already-rotated token indicates token theft
    if (storedToken.revoked) {
      const revokedJtis: string[] = [];
      if (storedToken.familyId) {
        const familyTokens = await this.prisma.refreshToken.findMany?.({
          where: { familyId: storedToken.familyId },
          select: { lastAccessJti: true },
        });
        for (const t of familyTokens || []) {
          if (t.lastAccessJti) revokedJtis.push(t.lastAccessJti);
        }

        await this.prisma.refreshToken.updateMany({
          where: { familyId: storedToken.familyId },
          data: { revoked: true },
        });

        this.logger.warn(
          `[SECURITY] Refresh token reuse detected for user ${storedToken.userId} (family=${storedToken.familyId}) — revoked entire session family (${revokedJtis.length} jti(s) flagged for Redis blacklist)`,
        );
      }

      throw new UnauthorizedException({
        message: 'Refresh token reuse detected — session family revoked',
        reuseDetected: true,
        revokedJtis,
      });
    }

    if (storedToken.expiresAt.getTime() < Date.now()) {
      await this.prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revoked: true },
      });
      throw new UnauthorizedException('Refresh token has expired');
    }

    // Rotate Refresh Token within the same session family
    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revoked: true },
    });

    const { user } = storedToken;
    const tokens = await this.issueTokenPair(
      user.id,
      user.email,
      user.role as UserRole,
      {
        familyId: storedToken.familyId || crypto.randomUUID(),
        userAgent: meta?.userAgent || storedToken.userAgent || undefined,
        ipAddress: meta?.ipAddress || storedToken.ipAddress || undefined,
      },
    );

    return {
      user: this.toUserDto(user),
      ...tokens,
    };
  }

  async logout(dto: RefreshTokenDto): Promise<{ success: boolean }> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revoked: false },
      data: { revoked: true },
    });
    return { success: true };
  }

  async getActiveSessions(
    userId: string,
    currentRefreshToken?: string,
  ): Promise<SessionDto[]> {
    const currentHash = currentRefreshToken
      ? this.hashRefreshToken(currentRefreshToken)
      : null;

    const rows = await this.prisma.refreshToken.findMany({
      where: {
        userId,
        revoked: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastUsedAt: 'desc' },
    });

    return rows.map((row) => ({
      id: row.id,
      familyId: row.familyId || row.id,
      deviceName: row.deviceName || parseDeviceName(row.userAgent || undefined),
      userAgent: row.userAgent || null,
      ipAddress: row.ipAddress || null,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      isCurrent: Boolean(currentHash && row.tokenHash === currentHash),
    }));
  }

  async revokeSession(
    userId: string,
    sessionId: string,
  ): Promise<{ success: boolean; revokedJtis: string[] }> {
    const session = await this.prisma.refreshToken.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      throw new NotFoundException('Session not found');
    }
    if (session.userId !== userId) {
      throw new ForbiddenException('You can only revoke your own sessions');
    }

    const revokedJtis: string[] = [];
    if (session.familyId) {
      const familyRows = await this.prisma.refreshToken.findMany({
        where: { familyId: session.familyId },
        select: { lastAccessJti: true },
      });
      for (const r of familyRows) {
        if (r.lastAccessJti) revokedJtis.push(r.lastAccessJti);
      }
      await this.prisma.refreshToken.updateMany({
        where: { familyId: session.familyId },
        data: { revoked: true },
      });
    } else {
      if (session.lastAccessJti) revokedJtis.push(session.lastAccessJti);
      await this.prisma.refreshToken.update({
        where: { id: session.id },
        data: { revoked: true },
      });
    }

    return { success: true, revokedJtis: [...new Set(revokedJtis)] };
  }

  async revokeAllSessions(
    userId: string,
  ): Promise<{ success: boolean; revokedCount: number; revokedJtis: string[] }> {
    const active = await this.prisma.refreshToken.findMany({
      where: { userId, revoked: false },
      select: { lastAccessJti: true },
    });
    const revokedJtis = [
      ...new Set(
        active
          .map((a) => a.lastAccessJti)
          .filter((jti): jti is string => Boolean(jti)),
      ),
    ];

    const updated = await this.prisma.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    });

    return {
      success: true,
      revokedCount: updated.count,
      revokedJtis,
    };
  }

  async setupTwoFactor(userId: string): Promise<TotpSetupResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const secret = generateBase32Secret();
    const otpauthUrl = buildOtpAuthUri(user.email, secret, 'NovaShop');
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: encryptTotpSecret(secret), totpEnabled: false },
    });

    return {
      secret,
      otpauthUrl,
      qrCodeDataUrl,
    };
  }

  async enableTwoFactor(
    userId: string,
    code: string,
  ): Promise<{ totpEnabled: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpSecret) {
      throw new BadRequestException(
        '2FA setup has not been initialized. Call /auth/2fa/setup first.',
      );
    }

    const plainSecret = decryptTotpSecret(user.totpSecret);
    if (!verifyTotpToken(plainSecret, code)) {
      throw new BadRequestException('Invalid 6-digit authenticator code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: true },
    });

    return { totpEnabled: true };
  }

  async disableTwoFactor(
    userId: string,
    code: string,
  ): Promise<{ totpEnabled: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpEnabled || !user.totpSecret) {
      throw new BadRequestException('2FA is not currently enabled');
    }

    const plainSecret = decryptTotpSecret(user.totpSecret);
    if (!verifyTotpToken(plainSecret, code)) {
      throw new BadRequestException('Invalid 6-digit authenticator code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: false, totpSecret: null },
    });

    return { totpEnabled: false };
  }

  async getMe(userId: string): Promise<UserDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return this.toUserDto(user);
  }

  async issueTokenPair(
    userId: string,
    email: string,
    role: UserRole,
    options?: {
      familyId?: string;
      userAgent?: string;
      ipAddress?: string;
    },
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const jti = crypto.randomUUID();
    const payload: JwtPayload = {
      sub: userId,
      email,
      role,
      jti,
    };
    const accessToken = await this.jwtService.signAsync(payload);
    const rawRefreshToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = this.hashRefreshToken(rawRefreshToken);
    const familyId = options?.familyId || crypto.randomUUID();

    const expiresAt = new Date(
      Date.now() + this.refreshTtlDays * 24 * 60 * 60 * 1000,
    );

    await this.prisma.refreshToken.create({
      data: {
        tokenHash,
        familyId,
        lastAccessJti: jti,
        userId,
        deviceName: parseDeviceName(options?.userAgent),
        userAgent: options?.userAgent || null,
        ipAddress: options?.ipAddress || null,
        expiresAt,
        revoked: false,
        lastUsedAt: new Date(),
      },
    });

    return {
      accessToken,
      refreshToken: rawRefreshToken,
    };
  }

  private toUserDto(user: {
    id: string;
    email: string;
    role: string;
    authProvider?: string;
    avatarUrl?: string | null;
    totpEnabled?: boolean;
    createdAt: Date;
  }): UserDto {
    return {
      id: user.id,
      email: user.email,
      role: user.role as UserRole,
      authProvider: user.authProvider || 'LOCAL',
      avatarUrl: user.avatarUrl ?? null,
      totpEnabled: Boolean(user.totpEnabled),
      createdAt: user.createdAt.toISOString(),
    };
  }
}
