import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import {
  JwtPayload,
  OrderStatusUpdatedWsPayload,
  ProductRestockedWsPayload,
  UserRole,
} from '@shop/contracts';

const ALLOWED_WS_ORIGINS = (
  process.env.CORS_ORIGINS ||
  'http://localhost,http://localhost:80,http://localhost:5173'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

@WebSocketGateway({
  cors: {
    origin: ALLOWED_WS_ORIGINS,
    credentials: true,
  },
})
export class NotificationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(NotificationGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
    const allowPublicMonitor = process.env.ALLOW_PUBLIC_SAGA_MONITOR === 'true';
    try {
      const rawToken =
        (client.handshake.auth?.token as string) ||
        (client.handshake.query?.token as string) ||
        '';
      const token = rawToken.replace(/^Bearer\s+/i, '');

      if (token) {
        const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
        const room = this.getUserRoom(payload.sub);
        await client.join(room);
        client.data.userId = payload.sub;
        client.data.role = payload.role;

        if (payload.role === UserRole.ADMIN || allowPublicMonitor) {
          await client.join('saga:monitor');
        }

        this.logger.log(
          `WebSocket client ${client.id} authenticated (${payload.role}) and joined room "${room}"`,
        );
        return;
      }

      if (allowPublicMonitor) {
        await client.join('saga:monitor');
        this.logger.debug(
          `WebSocket client ${client.id} joined public saga:monitor (ALLOW_PUBLIC_SAGA_MONITOR=true)`,
        );
        return;
      }

      this.logger.warn(
        `Rejected unauthenticated WebSocket connection ${client.id}`,
      );
      client.disconnect(true);
    } catch (err: any) {
      this.logger.warn(
        `WebSocket token verification failed for client ${client.id}: ${err?.message || err}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`WebSocket client ${client.id} disconnected`);
  }

  emitOrderStatusUpdated(payload: OrderStatusUpdatedWsPayload): void {
    const room = this.getUserRoom(payload.userId);
    if (this.server) {
      this.server
        .to([room, 'saga:monitor'])
        .emit('notification:order_status_updated', payload);
      this.logger.log(
        `Emitted notification:order_status_updated (${payload.status}) to room "${room}"`,
      );
    }
  }

  emitProductRestocked(
    userId: string,
    payload: ProductRestockedWsPayload,
  ): void {
    const room = this.getUserRoom(userId);
    if (this.server) {
      this.server.to(room).emit('notification:product_restocked', payload);
      this.logger.log(
        `Emitted notification:product_restocked (${payload.productTitle}) to room "${room}"`,
      );
    }
  }

  private getUserRoom(userId: string): string {
    return `user:${userId}`;
  }
}
