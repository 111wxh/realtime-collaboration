import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../common/config';

/**
 * Redis 连接的唯一持有者。
 *
 * 定位（计划书 §9.0 的原则）：Redis 只负责"快"和"广播"——presence、限流计数、
 * 跨实例广播；**不承担最终一致性状态**，所以它挂了不该让写操作走偏。
 * 对应地：Redis 不可用时 presence/限流退化到进程内存（单实例模式），
 * 一致性仍由 PostgreSQL 事务保证。
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client: Redis | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = config.redisUrl
      ? new Redis(config.redisUrl, {
          // 重连交给 ioredis 默认策略；命令失败快速抛出，让调用方走降级分支
          maxRetriesPerRequest: 2,
          retryStrategy: (times) => Math.min(times * 200, 3000),
          lazyConnect: false,
        })
      : null;

    if (this.client) {
      // 连接错误只记日志：Redis 是加速层，不阻塞进程启动
      this.client.on('error', () => {
        /* 由 ping() / 各调用方决定降级行为，这里吞掉避免 unhandled error 事件 */
      });
    }
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** 未启用 Redis（REDIS_URL 缺失）时返回 null，调用方据此走内存实现 */
  get raw(): Redis | null {
    return this.client;
  }

  async onModuleInit(): Promise<void> {
    if (!this.client) return;
    // 不 await connect：起不来时也要能提供服务（降级到内存模式）
    this.client.connect().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    await this.client.quit().catch(() => this.client?.disconnect());
  }

  /** 探测连通性；带超时，Redis 卡死时 /ready 不能跟着卡死 */
  async ping(timeoutMs = 1000): Promise<boolean> {
    if (!this.client) return false;
    try {
      const reply = await Promise.race([
        this.client.ping(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs),
        ),
      ]);
      return reply === 'PONG';
    } catch {
      return false;
    }
  }

  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    if (!this.client) throw new Error('Redis 未启用');
    return this.client.eval(script, keys.length, ...keys, ...args.map(String));
  }

  hgetall(key: string): Promise<Record<string, string>> {
    if (!this.client) throw new Error('Redis 未启用');
    return this.client.hgetall(key);
  }

  hget(key: string, field: string): Promise<string | null> {
    if (!this.client) throw new Error('Redis 未启用');
    return this.client.hget(key, field);
  }

  hset(key: string, data: Record<string, string>): Promise<number> {
    if (!this.client) throw new Error('Redis 未启用');
    return this.client.hset(key, data);
  }

  hdel(key: string, ...fields: string[]): Promise<number> {
    if (!this.client) throw new Error('Redis 未启用');
    return this.client.hdel(key, ...fields);
  }

  hincrby(key: string, field: string, delta: number): Promise<number> {
    if (!this.client) throw new Error('Redis 未启用');
    return this.client.hincrby(key, field, delta);
  }

  expire(key: string, seconds: number): Promise<number> {
    if (!this.client) throw new Error('Redis 未启用');
    return this.client.expire(key, seconds);
  }
}
