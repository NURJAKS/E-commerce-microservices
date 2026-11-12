import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtPayload, OrderStatusUpdatedWsPayload } from '@shop/contracts';

@WebSocketGateway({
  cors: {
    origin: '*',
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
    try {
      await client.join('saga:monitor');

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
        this.logger.log(
          `WebSocket client ${client.id} authenticated and joined room "${room}"`,
        );
      } else {
        this.logger.debug(`WebSocket client ${client.id} connected to saga:monitor`);
      }
    } catch (err: any) {
      this.logger.warn(
        `WebSocket token verification warning for client ${client.id}: ${err?.message || err}`,
      );
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

  private getUserRoom(userId: string): string {
    return `user:${userId}`;
  }
}
