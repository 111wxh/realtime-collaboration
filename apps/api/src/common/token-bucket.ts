/**
 * 令牌桶（纯逻辑，不依赖 Redis 与 Nest）——限流的核心算法。
 *
 * 为什么单独抽出来：服务端限流有两份实现（Redis Lua 支持多实例、进程内存兜底），
 * 两份实现必须共用同一套判定语义，单测直接测这个类即可覆盖边界
 * （容量耗尽 / 按时间匀速回填 / 不回填超过容量）。
 */
export interface TokenBucketOptions {
  /** 桶容量 = 允许的瞬时突发量 */
  capacity: number;
  /** 每秒回填的令牌数 = 稳态速率上限 */
  refillPerSecond: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly options: TokenBucketOptions,
    nowMs: number = Date.now(),
  ) {
    this.tokens = options.capacity;
    this.lastRefillMs = nowMs;
  }

  /** 按经过的时间线性回填，再判断本次消费是否放行 */
  tryConsume(cost = 1, nowMs: number = Date.now()): boolean {
    this.refill(nowMs);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** 当前可用令牌数（测试与观测用） */
  available(nowMs: number = Date.now()): number {
    this.refill(nowMs);
    return this.tokens;
  }

  private refill(nowMs: number): void {
    const elapsed = nowMs - this.lastRefillMs;
    if (elapsed <= 0) return;
    this.lastRefillMs = nowMs;
    this.tokens = Math.min(
      this.options.capacity,
      this.tokens + (elapsed / 1000) * this.options.refillPerSecond,
    );
  }
}

/** 写操作的配额（计划书 §7.7：写 60/s） */
export const WRITE_RATE = { capacity: 60, refillPerSecond: 60 } as const;
/** 光标事件的配额（计划书 §7.7：光标 30/s） */
export const CURSOR_RATE = { capacity: 30, refillPerSecond: 30 } as const;
