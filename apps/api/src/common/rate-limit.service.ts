import { Injectable, Logger } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';
import { TokenBucket, type TokenBucketOptions } from './token-bucket';

/**
 * 令牌桶的 Lua 版本：与 TokenBucket 类同一套语义，但把
 * "读令牌 → 回填 → 扣减 → 写回"压成一个原子脚本，多实例共享同一份计数。
 *
 * KEYS[1] 桶键；ARGV = capacity, refillPerSecond, nowMs, cost
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsed = now - ts
if elapsed > 0 then
  tokens = math.min(capacity, tokens + (elapsed / 1000) * refill)
end

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- 桶的空闲过期时间：装满一桶所需时间 + 余量，过期即视为新桶
redis.call('PEXPIRE', key, math.ceil(capacity / refill * 1000) + 60000)
return allowed
`;

/** 内存桶的垃圾回收间隔：超过这个时间没被碰过的键直接扔 */
const MEMORY_IDLE_MS = 10 * 60 * 1000;

/**
 * 限流入口。Redis 可用时走 Lua（多实例共享）；不可用时退化到进程内存
 * （单实例语义，够本地开发与测试用）。
 *
 * Redis 故障时选择 **fail-open** 并记 warn：限流是防滥用的护栏，
 * 不是正确性的一部分，不能因为它把正常用户全拒了。
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly memory = new Map<string, { bucket: TokenBucket; touchedAt: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly redis: RedisService) {
    this.sweeper = setInterval(() => this.sweepMemory(), MEMORY_IDLE_MS);
    // 定时器不该拖住进程退出（测试里尤其明显）
    this.sweeper.unref?.();
  }

  /** 消费一个令牌；false 表示超限（调用方回 RATE_LIMITED） */
  async consume(key: string, rate: TokenBucketOptions, cost = 1): Promise<boolean> {
    if (!this.redis.enabled) return this.consumeMemory(key, rate, cost);
    try {
      const result = await this.redis.eval(
        TOKEN_BUCKET_LUA,
        [`ratelimit:${key}`],
        [rate.capacity, rate.refillPerSecond, Date.now(), cost],
      );
      return Number(result) === 1;
    } catch (error) {
      this.logger.warn({ err: error, key }, 'Redis 限流不可用，降级为进程内存限流');
      return this.consumeMemory(key, rate, cost);
    }
  }

  private consumeMemory(key: string, rate: TokenBucketOptions, cost: number): boolean {
    const now = Date.now();
    let entry = this.memory.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(rate, now), touchedAt: now };
      this.memory.set(key, entry);
    }
    entry.touchedAt = now;
    return entry.bucket.tryConsume(cost, now);
  }

  private sweepMemory(): void {
    const deadline = Date.now() - MEMORY_IDLE_MS;
    for (const [key, entry] of this.memory) {
      if (entry.touchedAt < deadline) this.memory.delete(key);
    }
  }
}
