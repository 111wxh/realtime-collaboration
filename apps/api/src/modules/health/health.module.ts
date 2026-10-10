import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/** 健康检查依赖 PrismaService / RedisService（都是 @Global 模块导出的） */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
