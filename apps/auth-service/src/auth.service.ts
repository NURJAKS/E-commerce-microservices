import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import {
  AuthTokensResponse,
  JwtPayload,
  LoginDto,
  RefreshTokenDto,
  RegisterDto,
  UserDto,
  UserRegisteredEvent,
  UserRole,
} from '@shop/contracts';
import { RabbitMQService, ROUTING_KEYS } from '@shop/rmq';
import { PrismaService } from './prisma.service';

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
    const adminEmail = 'admin@shop.local';
    const existing = await this.prisma.user.findUnique({
      where: { email: adminEmail },
    });
    if (!existing) {
      const passwordHash = await this.hashPassword('AdminPass123!');
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

  async register(dto: RegisterDto): Promise<AuthTokensResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ConflictException('User with this email already exists');
    }

    const passwordHash = await this.hashPassword(dto.password);
    const role = dto.role || UserRole.CUSTOMER;

    const user = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        role,
      },
    });

    const tokens = await this.issueTokenPair(
      user.id,
      user.email,
      user.role as UserRole,
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

  async login(dto: LoginDto): Promise<AuthTokensResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await this.verifyPassword(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const tokens = await this.issueTokenPair(
      user.id,
      user.email,
      user.role as UserRole,
    );

    return {
      user: this.toUserDto(user),
      ...tokens,
    };
  }

  async refreshTokens(dto: RefreshTokenDto): Promise<AuthTokensResponse> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!storedToken || storedToken.revoked) {
      throw new UnauthorizedException('Invalid or revoked refresh token');
    }

    if (storedToken.expiresAt.getTime() < Date.now()) {
      await this.prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revoked: true },
      });
      throw new UnauthorizedException('Refresh token has expired');
    }

    // Rotate Refresh Token: revoke the old token before issuing a new pair
    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revoked: true },
    });

    const { user } = storedToken;
    const tokens = await this.issueTokenPair(
      user.id,
      user.email,
      user.role as UserRole,
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
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const payload: JwtPayload = {
      sub: userId,
      email,
      role,
      jti: crypto.randomUUID(),
    };
    const accessToken = await this.jwtService.signAsync(payload);
    const rawRefreshToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = this.hashRefreshToken(rawRefreshToken);

    const expiresAt = new Date(
      Date.now() + this.refreshTtlDays * 24 * 60 * 60 * 1000,
    );

    await this.prisma.refreshToken.create({
      data: {
        tokenHash,
        userId,
        expiresAt,
        revoked: false,
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
    createdAt: Date;
  }): UserDto {
    return {
      id: user.id,
      email: user.email,
      role: user.role as UserRole,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
