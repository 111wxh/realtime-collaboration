import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 客户端生命周期。
 *
 * - onModuleInit 里 $connect：连接失败要立刻暴露（PostgreSQL 是权威存储，
 *   没有它服务没有意义），而不是等到第一个请求才 500；
 * - onModuleDestroy + main.ts 的 enableShutdownHooks：SIGTERM 时优雅断开，
 *   配合 Nest 的 shutdown hooks 让容器里的滚动重启不丢在途事务。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('PostgreSQL 连接已建立');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** /ready 用：轻量探测（SELECT 1），不查业务表 */
  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
