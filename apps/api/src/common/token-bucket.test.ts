import { describe, expect, it } from 'vitest';

import { CURSOR_RATE, TokenBucket, WRITE_RATE } from './token-bucket';

describe('TokenBucket', () => {
  it('容量内放行，容量耗尽后拒绝', () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 }, 0);
    expect(bucket.tryConsume(1, 0)).toBe(true);
    expect(bucket.tryConsume(1, 0)).toBe(true);
    expect(bucket.tryConsume(1, 0)).toBe(true);
    // 第 4 次在同一时刻：桶空
    expect(bucket.tryConsume(1, 0)).toBe(false);
  });

  it('按时间线性回填，1 秒后补 1 个令牌', () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 }, 0);
    bucket.tryConsume(1, 0);
    bucket.tryConsume(1, 0);
    expect(bucket.tryConsume(1, 0)).toBe(false);
    expect(bucket.tryConsume(1, 1000)).toBe(true);
    expect(bucket.tryConsume(1, 1000)).toBe(false);
  });

  it('回填不会超过容量（长时间空闲后不能一次性透支）', () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 10 }, 0);
    // 空闲 1 小时：仍然只有 capacity 个令牌
    expect(bucket.available(3_600_000)).toBe(2);
    expect(bucket.tryConsume(1, 3_600_000)).toBe(true);
    expect(bucket.tryConsume(1, 3_600_000)).toBe(true);
    expect(bucket.tryConsume(1, 3_600_000)).toBe(false);
  });

  it('小数回填：500ms 给半个令牌，不足以消费', () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, 0);
    bucket.tryConsume(1, 0);
    expect(bucket.available(500)).toBeCloseTo(0.5, 5);
    expect(bucket.tryConsume(1, 500)).toBe(false);
    expect(bucket.tryConsume(1, 1000)).toBe(true);
  });

  it('时间倒流（nowMs 变小）不会凭空回填', () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, 10_000);
    bucket.tryConsume(1, 10_000);
    expect(bucket.tryConsume(1, 5_000)).toBe(false);
  });

  it('一次消费多个令牌（cost > 1）', () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 }, 0);
    expect(bucket.tryConsume(5, 0)).toBe(true);
    expect(bucket.tryConsume(1, 0)).toBe(false);
  });

  it('配额常量与计划书一致（写 60/s、光标 30/s）', () => {
    expect(WRITE_RATE).toEqual({ capacity: 60, refillPerSecond: 60 });
    expect(CURSOR_RATE).toEqual({ capacity: 30, refillPerSecond: 30 });
  });
});
