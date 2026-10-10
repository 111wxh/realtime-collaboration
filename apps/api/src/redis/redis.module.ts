import { Global, Module } from '@nestjs/common';

import { RedisService } from './redis.service';

/**
 * 全局模块：RedisService 被 presence / 限流 / WS 广播适配器共用，
 * 到处 import 反而噪音大。
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
