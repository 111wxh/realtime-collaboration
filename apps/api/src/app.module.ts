import { randomUUID } from 'node:crypto';

import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Logger, LoggerModule } from 'nestjs-pino';

import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { AppConfigModule } from './common/config.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { BoardModule } from './modules/board/board.module';
import { PresenceModule } from './modules/presence/presence.module';
import { RoomModule } from './modules/room/room.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';

/**
 * 根模块。装配顺序即依赖方向：
 *   AppConfigModule / RedisModule / PrismaModule（基础设施，全局）
 *   → HealthModule（探活/就绪）
 *   → AuthModule / RoomModule / BoardModule / PresenceModule（领域）
 *   → RealtimeModule（WS 网关，消费上面全部领域服务）
 *
 * 全局异常过滤器在这里注册（APP_FILTER）而不是 main.ts，
 * 这样它能注入 Nest 的 Logger（结构化日志带 requestId）。
 */
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // requestId 贯穿 REST 与日志：优先复用入口已有的 x-request-id
        genReqId: (req, res) => {
          const existing = req.headers['x-request-id'];
          const id = typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
        redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], remove: true },
      },
    }),
    PrismaModule,
    RedisModule,
    AppConfigModule,
    HealthModule,
    AuthModule,
    RoomModule,
    BoardModule,
    PresenceModule,
    RealtimeModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useFactory: (logger: Logger) =>
        new AllExceptionsFilter({
          error: (obj, msg) => logger.error(obj, msg),
          warn: (obj, msg) => logger.warn(obj, msg),
        }),
      inject: [Logger],
    },
  ],
})
export class AppModule {}
