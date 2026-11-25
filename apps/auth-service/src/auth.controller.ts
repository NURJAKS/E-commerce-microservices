import { Controller, UseFilters, UseInterceptors } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AUTH_PATTERNS,
  LoginDto,
  RefreshTokenDto,
  RegisterDto,
  SessionMetadata,
} from '@shop/contracts';
import { AllRpcExceptionFilter, LoggingInterceptor } from '@shop/common';
import { AuthService } from './auth.service';

@Controller()
@UseFilters(new AllRpcExceptionFilter())
@UseInterceptors(new LoggingInterceptor())
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @MessagePattern(AUTH_PATTERNS.REGISTER)
  register(@Payload() data: RegisterDto & { meta?: SessionMetadata }) {
    return this.authService.register(data, data.meta);
  }

  @MessagePattern(AUTH_PATTERNS.LOGIN)
  login(@Payload() data: LoginDto & { meta?: SessionMetadata }) {
    return this.authService.login(data, data.meta);
  }

  @MessagePattern(AUTH_PATTERNS.OAUTH_GOOGLE_LOGIN)
  loginWithGoogle(
    @Payload()
    data: {
      googleId: string;
      email: string;
      avatarUrl?: string;
      meta?: SessionMetadata;
    },
  ) {
    return this.authService.loginWithGoogle(data, data.meta);
  }

  @MessagePattern(AUTH_PATTERNS.REFRESH)
  refresh(@Payload() data: RefreshTokenDto & { meta?: SessionMetadata }) {
    return this.authService.refreshTokens(data, data.meta);
  }

  @MessagePattern(AUTH_PATTERNS.LOGOUT)
  logout(@Payload() dto: RefreshTokenDto) {
    return this.authService.logout(dto);
  }

  @MessagePattern(AUTH_PATTERNS.ME)
  me(@Payload() data: { userId: string }) {
    return this.authService.getMe(data.userId);
  }

  @MessagePattern(AUTH_PATTERNS.GET_SESSIONS)
  getSessions(
    @Payload() data: { userId: string; currentRefreshToken?: string },
  ) {
    return this.authService.getActiveSessions(
      data.userId,
      data.currentRefreshToken,
    );
  }

  @MessagePattern(AUTH_PATTERNS.REVOKE_SESSION)
  revokeSession(@Payload() data: { userId: string; sessionId: string }) {
    return this.authService.revokeSession(data.userId, data.sessionId);
  }

  @MessagePattern(AUTH_PATTERNS.REVOKE_ALL_SESSIONS)
  revokeAllSessions(@Payload() data: { userId: string }) {
    return this.authService.revokeAllSessions(data.userId);
  }

  @MessagePattern(AUTH_PATTERNS.SETUP_2FA)
  setupTwoFactor(@Payload() data: { userId: string }) {
    return this.authService.setupTwoFactor(data.userId);
  }

  @MessagePattern(AUTH_PATTERNS.ENABLE_2FA)
  enableTwoFactor(@Payload() data: { userId: string; code: string }) {
    return this.authService.enableTwoFactor(data.userId, data.code);
  }

  @MessagePattern(AUTH_PATTERNS.DISABLE_2FA)
  disableTwoFactor(@Payload() data: { userId: string; code: string }) {
    return this.authService.disableTwoFactor(data.userId, data.code);
  }
}
