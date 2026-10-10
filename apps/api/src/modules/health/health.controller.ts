import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

interface ReadyBody {
  status: 'ok' | 'error';
  checks: Record<string, 'ok' | 'fail' | 'disabled'>;
}

/**
 * `/health` 与 `/ready` 的分工：
 *  - `/health`：进程活着就返回 200（liveness）；依赖挂了也不该被重启，所以不探测外部依赖。
 *  - `/ready`：PostgreSQL 与 Redis 都能连通才返回 200（readiness）；
 *    任一不可用返回 503，让负载均衡在依赖恢复前把实例摘出去。
 *
 * 探测都是有超时的轻量动作：pg `SELECT 1`、redis `PING`，不做业务查询。
 */
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('health')
  health(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: process.uptime() };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadyBody> {
    const [postgres, redis] = await Promise.all([
      this.prisma.isHealthy(),
      this.redis.enabled ? this.redis.ping() : Promise.resolve<boolean | null>(null),
    ]);

    const checks: ReadyBody['checks'] = {
      postgres: postgres ? 'ok' : 'fail',
      // 未配置 REDIS_URL 表示刻意跑单实例模式：不算不健康
      redis: redis === null ? 'disabled' : redis ? 'ok' : 'fail',
    };
    const ok = checks.postgres === 'ok' && checks.redis !== 'fail';
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'error', checks };
  }
}
