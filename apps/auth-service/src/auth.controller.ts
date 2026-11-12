import { Controller, UseFilters, UseInterceptors } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AUTH_PATTERNS,
  LoginDto,
  RefreshTokenDto,
  RegisterDto,
} from '@shop/contracts';
import { AllRpcExceptionFilter, LoggingInterceptor } from '@shop/common';
import { AuthService } from './auth.service';

@Controller()
@UseFilters(new AllRpcExceptionFilter())
@UseInterceptors(new LoggingInterceptor())
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @MessagePattern(AUTH_PATTERNS.REGISTER)
  register(@Payload() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @MessagePattern(AUTH_PATTERNS.LOGIN)
  login(@Payload() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @MessagePattern(AUTH_PATTERNS.REFRESH)
  refresh(@Payload() dto: RefreshTokenDto) {
    return this.authService.refreshTokens(dto);
  }

  @MessagePattern(AUTH_PATTERNS.LOGOUT)
  logout(@Payload() dto: RefreshTokenDto) {
    return this.authService.logout(dto);
  }

  @MessagePattern(AUTH_PATTERNS.ME)
  me(@Payload() data: { userId: string }) {
    return this.authService.getMe(data.userId);
  }
}
