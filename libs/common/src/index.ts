import {
  ArgumentsHost,
  CallHandler,
  Catch,
  createParamDecorator,
  ExecutionContext,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
  RpcExceptionFilter,
  SetMetadata,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { Observable, tap, throwError } from 'rxjs';
import { CurrentUserPayload, UserRole } from '@shop/contracts';

// ==========================================
// Decorators
// ==========================================

export const ROLES_KEY = 'roles';
export const IS_PUBLIC_KEY = 'isPublic';

export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator(
  (data: keyof CurrentUserPayload | undefined, ctx: ExecutionContext) => {
    const type = ctx.getType();
    let user: CurrentUserPayload | undefined;

    if (type === 'http') {
      const request = ctx.switchToHttp().getRequest();
      user = request.user;
    } else if (type === 'rpc') {
      const rpcData = ctx.switchToRpc().getData();
      if (rpcData && rpcData.__headers) {
        user = {
          userId: rpcData.__headers['x-user-id'],
          role: rpcData.__headers['x-user-role'] as UserRole,
          email: rpcData.__headers['x-user-email'],
          traceId: rpcData.__headers['x-trace-id'],
        };
      }
    }

    if (!user) {
      return undefined;
    }

    return data ? user[data] : user;
  },
);

// ==========================================
// Exception Filters
// ==========================================

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse() as any;
      message = typeof res === 'string' ? res : res.message || exception.message;
    } else if (exception && typeof exception === 'object') {
      const errObj = exception.error || exception;
      if (typeof errObj.statusCode === 'number') {
        status = errObj.statusCode;
      }
      if (errObj.message) {
        message = errObj.message;
      }
    }

    const traceId =
      request.headers?.['x-trace-id'] ||
      crypto.randomBytes(16).toString('hex');

    this.logger.warn(
      `[traceId=${traceId}] HTTP ${status} on ${request.method} ${request.url}: ${JSON.stringify(message)}`,
    );

    response.status(status).json({
      statusCode: status,
      message,
      traceId,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}

@Catch()
export class AllRpcExceptionFilter implements RpcExceptionFilter<any> {
  private readonly logger = new Logger(AllRpcExceptionFilter.name);

  catch(exception: any, _host: ArgumentsHost): Observable<any> {
    if (exception instanceof RpcException) {
      return throwError(() => exception.getError());
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse() as any;
      const message =
        typeof res === 'string' ? res : res.message || exception.message;
      return throwError(() => ({
        statusCode: status,
        message,
      }));
    }

    this.logger.error(
      `Unhandled RPC exception: ${exception?.message || exception}`,
      exception?.stack,
    );

    return throwError(() => ({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: exception?.message || 'Internal microservice error',
    }));
  }
}

// ==========================================
// Correlation TraceId & Logging Interceptor
// ==========================================

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const startTimeMs = Date.now();
    const type = context.getType();

    if (type === 'http') {
      const req = context.switchToHttp().getRequest();
      const res = context.switchToHttp().getResponse();
      const { method, url } = req;

      const traceId =
        (req.headers['x-trace-id'] as string) ||
        crypto.randomBytes(16).toString('hex');
      req.headers['x-trace-id'] = traceId;
      if (req.user) {
        req.user.traceId = traceId;
      }
      if (res && typeof res.setHeader === 'function') {
        res.setHeader('X-Trace-Id', traceId);
      }

      return next.handle().pipe(
        tap(() => {
          const duration = Date.now() - startTimeMs;
          this.logger.log(
            `[traceId=${traceId}] ${method} ${url} - ${duration}ms`,
          );
        }),
      );
    }

    const rpcData = context.switchToRpc().getData();
    const traceId =
      rpcData?.__headers?.['x-trace-id'] ||
      crypto.randomBytes(16).toString('hex');
    const handlerName = context.getHandler().name;

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - startTimeMs;
        this.logger.debug(
          `[traceId=${traceId}] RPC [${handlerName}] - ${duration}ms`,
        );
      }),
    );
  }
}

/**
 * Helper to attach internal user identity headers (`x-user-id`, `x-user-role`, `x-user-email`, `x-trace-id`)
 * to internal TCP/RMQ microservice payloads from the API Gateway.
 */
export function withInternalHeaders<T extends Record<string, any>>(
  payload: T,
  user?: CurrentUserPayload,
  traceId?: string,
): T & {
  __headers: {
    'x-user-id'?: string;
    'x-user-role'?: UserRole;
    'x-user-email'?: string;
    'x-trace-id'?: string;
  };
} {
  return {
    ...payload,
    __headers: {
      'x-user-id': user?.userId,
      'x-user-role': user?.role,
      'x-user-email': user?.email,
      'x-trace-id': traceId || user?.traceId,
    },
  };
}
