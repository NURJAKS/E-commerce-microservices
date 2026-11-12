import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { firstValueFrom } from 'rxjs';
import { CurrentUser, Public, withInternalHeaders } from '@shop/common';
import {
  AUTH_PATTERNS,
  AuthTokensResponse,
  CurrentUserPayload,
  JwtPayload,
  LoginDto,
  RegisterDto,
  SERVICES,
} from '@shop/contracts';
import { SecurityRedisService } from '../security-redis.service';

export const REFRESH_COOKIE_NAME = 'refresh_token';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

@ApiTags('Auth')
@Controller('auth')
export class AuthGatewayController {
  constructor(
    @Inject(SERVICES.AUTH) private readonly authClient: ClientProxy,
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(SecurityRedisService)
    private readonly securityRedis: SecurityRedisService,
  ) {}

  private setRefreshTokenCookie(res: Response, refreshToken: string): void {
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: SEVEN_DAYS_MS,
    });
  }

  private clearRefreshTokenCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
    });
  }

  @Public()
  @Post('register')
  @ApiOperation({
    summary:
      'Register a new user account (sets Refresh Token in HttpOnly SameSite=Strict cookie)',
  })
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await firstValueFrom(
      this.authClient.send<AuthTokensResponse>(AUTH_PATTERNS.REGISTER, dto),
    );
    this.setRefreshTokenCookie(res, result.refreshToken);
    return result;
  }

  @Public()
  @Post('login')
  @ApiOperation({
    summary:
      'Authenticate with email & password (sets Refresh Token in HttpOnly SameSite=Strict cookie)',
  })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await firstValueFrom(
      this.authClient.send<AuthTokensResponse>(AUTH_PATTERNS.LOGIN, dto),
    );
    this.setRefreshTokenCookie(res, result.refreshToken);
    return result;
  }

  @Public()
  @Post('refresh')
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: { refreshToken: { type: 'string' } },
    },
  })
  @ApiOperation({
    summary:
      'Rotate Refresh Token from HttpOnly cookie (or body fallback) and issue new pair',
  })
  async refresh(
    @Req() req: Request,
    @Body() body: { refreshToken?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken =
      req.cookies?.[REFRESH_COOKIE_NAME] || body?.refreshToken;
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token cookie or body missing');
    }

    const result = await firstValueFrom(
      this.authClient.send<AuthTokensResponse>(AUTH_PATTERNS.REFRESH, {
        refreshToken,
      }),
    );
    this.setRefreshTokenCookie(res, result.refreshToken);
    return result;
  }

  @Public()
  @Post('logout')
  @ApiOperation({
    summary:
      'Revoke Refresh Token, clear HttpOnly cookie, and blacklist active JWT Access Token in Redis',
  })
  async logout(
    @Req() req: Request,
    @Body() body: { refreshToken?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    // 1. Blacklist active Access Token in Redis (jwt_blacklist:<jti>) if present
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const accessToken = authHeader.slice(7).trim();
      try {
        const decoded = this.jwtService.decode(accessToken) as JwtPayload | null;
        if (decoded?.jti) {
          const remainingSeconds = decoded.exp
            ? Math.max(1, decoded.exp - Math.floor(Date.now() / 1000))
            : 900;
          await this.securityRedis.blacklistAccessToken(
            decoded.jti,
            remainingSeconds,
          );
        }
      } catch {
        // Ignore malformed token on logout
      }
    }

    // 2. Revoke Refresh Token in Auth DB and clear HttpOnly cookie
    const refreshToken =
      req.cookies?.[REFRESH_COOKIE_NAME] || body?.refreshToken;
    this.clearRefreshTokenCookie(res);

    if (refreshToken) {
      await firstValueFrom(
        this.authClient.send(AUTH_PATTERNS.LOGOUT, { refreshToken }),
      );
    }

    return { success: true };
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Get authenticated user profile' })
  me(@CurrentUser() user: CurrentUserPayload) {
    return firstValueFrom(
      this.authClient.send(
        AUTH_PATTERNS.ME,
        withInternalHeaders({ userId: user.userId }, user),
      ),
    );
  }
}
