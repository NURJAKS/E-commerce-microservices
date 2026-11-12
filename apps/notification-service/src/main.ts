import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NotificationModule } from './notification.module';

async function bootstrap() {
  const logger = new Logger('NotificationService');
  const port = Number(process.env.NOTIFICATION_SERVICE_PORT || 3005);

  const app = await NestFactory.create(NotificationModule, { cors: true });
  await app.listen(port, '0.0.0.0');
  logger.log(
    `Notification Service & WebSocket Gateway listening on port ${port}`,
  );
}

bootstrap();
