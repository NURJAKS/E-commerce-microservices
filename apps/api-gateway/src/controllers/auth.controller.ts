import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Logger,
  Param,
  Post,
  Query,
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
import axios from 'axios';
import * as crypto from 'crypto';
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
  SessionMetadata,
  TotpCodeDto,
} from '@shop/contracts';
import { SecurityRedisService } from '../security-redis.service';

export const REFRESH_COOKIE_NAME = 'refresh_token';
export const OAUTH_STATE_COOKIE_NAME = 'oauth_state';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

@ApiTags('Auth')
@Controller('auth')
export class AuthGatewayController {
  private readonly logger = new Logger(AuthGatewayController.name);

  constructor(
    @Inject(SERVICES.AUTH) private readonly authClient: ClientProxy,
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(SecurityRedisService)
    private readonly securityRedis: SecurityRedisService,
  ) {}

  private extractSessionMeta(req: Request): SessionMetadata {
    const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const userAgent = (req.headers['user-agent'] as string) || undefined;
    return { userAgent, ipAddress: ip };
  }

  private isCookieSecure(): boolean {
    if (process.env.COOKIE_SECURE === 'true') return true;
    if (process.env.COOKIE_SECURE === 'false') return false;
    const frontendUrl = (process.env.FRONTEND_PUBLIC_URL || '').trim();
    if (frontendUrl) {
      return frontendUrl.startsWith('https://');
    }
    return process.env.NODE_ENV === 'production';
  }

  private setRefreshTokenCookie(res: Response, refreshToken: string): void {
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: this.isCookieSecure(),
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: SEVEN_DAYS_MS,
    });
  }

  private clearRefreshTokenCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      secure: this.isCookieSecure(),
      sameSite: 'strict',
      path: '/api/auth',
    });
  }

  private async blacklistJtis(jtis?: string[]): Promise<void> {
    if (!jtis || jtis.length === 0) return;
    await Promise.all(
      jtis.map((jti) => this.securityRedis.blacklistAccessToken(jti, 900)),
    );
  }

  @Public()
  @Post('register')
  @ApiOperation({
    summary:
      'Register a new user account (sets Refresh Token in HttpOnly SameSite=Strict cookie)',
  })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await firstValueFrom(
      this.authClient.send<AuthTokensResponse>(AUTH_PATTERNS.REGISTER, {
        ...dto,
        meta: this.extractSessionMeta(req),
      }),
    );
    this.setRefreshTokenCookie(res, result.refreshToken);
    return result;
  }

  @Public()
  @Post('login')
  @ApiOperation({
    summary:
      'Authenticate with email & password (+ optional TOTP 2FA code; sets HttpOnly Refresh Token cookie)',
  })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await firstValueFrom(
      this.authClient.send<AuthTokensResponse>(AUTH_PATTERNS.LOGIN, {
        ...dto,
        meta: this.extractSessionMeta(req),
      }),
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
      'Rotate Refresh Token with Reuse Detection (revokes entire session family & blacklists active JTIs in Redis on replay)',
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

    try {
      const result = await firstValueFrom(
        this.authClient.send<AuthTokensResponse>(AUTH_PATTERNS.REFRESH, {
          refreshToken,
          meta: this.extractSessionMeta(req),
        }),
      );
      this.setRefreshTokenCookie(res, result.refreshToken);
      return result;
    } catch (err: any) {
      const errObj = err?.error || err;
      if (errObj?.reuseDetected) {
        await this.blacklistJtis(errObj.revokedJtis);
        this.clearRefreshTokenCookie(res);
      }
      throw err;
    }
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

  // ==========================================
  // Active Sessions Management
  // ==========================================

  @ApiBearerAuth()
  @Get('sessions')
  @ApiOperation({
    summary: 'List active device sessions (browser, IP, login & last-used dates)',
  })
  getSessions(@CurrentUser() user: CurrentUserPayload, @Req() req: Request) {
    const currentRefreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    return firstValueFrom(
      this.authClient.send(
        AUTH_PATTERNS.GET_SESSIONS,
        withInternalHeaders(
          { userId: user.userId, currentRefreshToken },
          user,
        ),
      ),
    );
  }

  @ApiBearerAuth()
  @Delete('sessions/:sessionId')
  @ApiOperation({
    summary:
      'Terminate a specific device session and immediately blacklist its active JWT jti in Redis',
  })
  async revokeSession(
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const result = await firstValueFrom(
      this.authClient.send<{ success: boolean; revokedJtis: string[] }>(
        AUTH_PATTERNS.REVOKE_SESSION,
        withInternalHeaders({ userId: user.userId, sessionId }, user),
      ),
    );
    await this.blacklistJtis(result.revokedJtis);
    return { success: result.success };
  }

  @ApiBearerAuth()
  @Post('sessions/revoke-all')
  @ApiOperation({
    summary:
      'Log out from all devices: revokes all refresh token families and blacklists all active JWT JTIs in Redis',
  })
  async revokeAllSessions(
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await firstValueFrom(
      this.authClient.send<{
        success: boolean;
        revokedCount: number;
        revokedJtis: string[];
      }>(
        AUTH_PATTERNS.REVOKE_ALL_SESSIONS,
        withInternalHeaders({ userId: user.userId }, user),
      ),
    );

    const jtisToBlacklist = [...(result.revokedJtis || [])];
    if (user.jti) {
      jtisToBlacklist.push(user.jti);
    }
    await this.blacklistJtis([...new Set(jtisToBlacklist)]);
    this.clearRefreshTokenCookie(res);

    return {
      success: result.success,
      revokedCount: result.revokedCount,
    };
  }

  // ==========================================
  // 2FA (TOTP — Google Authenticator)
  // ==========================================

  @ApiBearerAuth()
  @Post('2fa/setup')
  @ApiOperation({
    summary:
      'Initialize TOTP 2FA setup (returns Base32 secret, otpauth URI & QR code Data URL)',
  })
  setupTwoFactor(@CurrentUser() user: CurrentUserPayload) {
    return firstValueFrom(
      this.authClient.send(
        AUTH_PATTERNS.SETUP_2FA,
        withInternalHeaders({ userId: user.userId }, user),
      ),
    );
  }

  @ApiBearerAuth()
  @Post('2fa/enable')
  @ApiOperation({
    summary: 'Verify a 6-digit Google Authenticator code and enable 2FA',
  })
  enableTwoFactor(
    @Body() dto: TotpCodeDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.authClient.send(
        AUTH_PATTERNS.ENABLE_2FA,
        withInternalHeaders({ userId: user.userId, code: dto.code }, user),
      ),
    );
  }

  @ApiBearerAuth()
  @Post('2fa/disable')
  @ApiOperation({
    summary: 'Verify a 6-digit authenticator code and disable 2FA',
  })
  disableTwoFactor(
    @Body() dto: TotpCodeDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return firstValueFrom(
      this.authClient.send(
        AUTH_PATTERNS.DISABLE_2FA,
        withInternalHeaders({ userId: user.userId, code: dto.code }, user),
      ),
    );
  }

  // ==========================================
  // Google OAuth 2.0 (Authorization Code Flow)
  // ==========================================

  @Public()
  @Get('google')
  @ApiOperation({
    summary:
      'Initiate Google OAuth 2.0 Sign-In / Sign-Up (redirects to Google consent screen with CSRF state cookie)',
  })
  googleOAuthStart(@Res() res: Response) {
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const frontendUrl = (
      process.env.FRONTEND_PUBLIC_URL || 'http://localhost'
    ).replace(/\/$/, '');

    if (!clientId || !clientSecret) {
      return res.redirect(`${frontendUrl}/login?oauth_error=google_not_configured`);
    }

    const callbackUrl =
      (process.env.GOOGLE_CALLBACK_URL || '').trim() ||
      `${frontendUrl}/api/auth/google/callback`;

    const state = crypto.randomBytes(24).toString('hex');
    res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
      httpOnly: true,
      secure: this.isCookieSecure(),
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: TEN_MINUTES_MS,
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'select_account',
      state,
    });

    return res.redirect(
      `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    );
  }

  @Public()
  @Get('google/callback')
  @ApiOperation({
    summary:
      'Google OAuth 2.0 callback — verifies CSRF state, exchanges code for user profile, sets HttpOnly session cookie',
  })
  async googleOAuthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') oauthError: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const frontendUrl = (
      process.env.FRONTEND_PUBLIC_URL || 'http://localhost'
    ).replace(/\/$/, '');

    const storedState = req.cookies?.[OAUTH_STATE_COOKIE_NAME];
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/auth',
    });

    if (oauthError || !code) {
      return res.redirect(`${frontendUrl}/login?oauth_error=access_denied`);
    }

    if (!state || !storedState || state !== storedState) {
      this.logger.warn('[Google OAuth] CSRF state mismatch — rejecting callback');
      return res.redirect(`${frontendUrl}/login?oauth_error=invalid_state`);
    }

    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const callbackUrl =
      (process.env.GOOGLE_CALLBACK_URL || '').trim() ||
      `${frontendUrl}/api/auth/google/callback`;

    if (!clientId || !clientSecret) {
      return res.redirect(`${frontendUrl}/login?oauth_error=google_not_configured`);
    }

    try {
      const tokenRes = await axios.post<{ access_token: string }>(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: callbackUrl,
          grant_type: 'authorization_code',
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );

      const userInfoRes = await axios.get<{
        sub: string;
        email: string;
        picture?: string;
      }>('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
      });

      const result = await firstValueFrom(
        this.authClient.send<AuthTokensResponse>(
          AUTH_PATTERNS.OAUTH_GOOGLE_LOGIN,
          {
            googleId: userInfoRes.data.sub,
            email: userInfoRes.data.email,
            avatarUrl: userInfoRes.data.picture,
            meta: this.extractSessionMeta(req),
          },
        ),
      );

      this.setRefreshTokenCookie(res, result.refreshToken);
      return res.redirect(`${frontendUrl}/login?oauth=success`);
    } catch (err: any) {
      this.logger.error(
        `[Google OAuth] Callback exchange failed: ${err?.message || err}`,
      );
      return res.redirect(`${frontendUrl}/login?oauth_error=exchange_failed`);
    }
  }
}
