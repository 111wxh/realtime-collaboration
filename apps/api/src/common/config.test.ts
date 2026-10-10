import { describe, expect, it } from 'vitest';

import { loadConfig, parseDurationMs } from './config';

describe('parseDurationMs', () => {
  it('解析 s/m/h/d/ms 后缀', () => {
    expect(parseDurationMs('30s', 0)).toBe(30_000);
    expect(parseDurationMs('15m', 0)).toBe(900_000);
    expect(parseDurationMs('2h', 0)).toBe(7_200_000);
    expect(parseDurationMs('30d', 0)).toBe(2_592_000_000);
    expect(parseDurationMs('500ms', 0)).toBe(500);
  });

  it('纯数字按秒（与 JWT 生态一致）', () => {
    expect(parseDurationMs('900', 0)).toBe(900_000);
  });

  it('空值与非法值回落到 fallback，而不是抛错', () => {
    expect(parseDurationMs(undefined, 1234)).toBe(1234);
    expect(parseDurationMs('', 1234)).toBe(1234);
    expect(parseDurationMs('半个月', 1234)).toBe(1234);
    expect(parseDurationMs('30 d', 1234)).toBe(1234);
  });
});

describe('loadConfig', () => {
  const baseEnv = { DATABASE_URL: 'postgresql://app:app@localhost:5433/collab' };

  it('缺少 DATABASE_URL 直接抛错（权威存储不可缺省）', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('缺省值符合计划书 §11.2', () => {
    const config = loadConfig(baseEnv);
    expect(config.port).toBe(3001);
    expect(config.corsOrigins).toEqual(['http://localhost:3000']);
    expect(config.jwtExpiresIn).toBe('15m');
    expect(config.refreshTokenTtlMs).toBe(30 * 86_400_000);
    expect(config.wsMaxBuffer).toBe(1_048_576);
    expect(config.oplogRetentionDays).toBe(7);
    expect(config.logLevel).toBe('info');
  });

  it('REDIS_URL 为空表示退化到单实例内存模式', () => {
    expect(loadConfig(baseEnv).redisUrl).toBeNull();
    expect(loadConfig({ ...baseEnv, REDIS_URL: '   ' }).redisUrl).toBeNull();
    expect(loadConfig({ ...baseEnv, REDIS_URL: 'redis://localhost:6379' }).redisUrl).toBe(
      'redis://localhost:6379',
    );
  });

  it('CORS_ORIGIN 支持逗号分隔多来源', () => {
    const config = loadConfig({ ...baseEnv, CORS_ORIGIN: 'http://a.test, http://b.test' });
    expect(config.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('非法端口/上限值回落到默认值（配置错不该让服务起不来）', () => {
    const config = loadConfig({ ...baseEnv, PORT: 'abc', WS_MAX_BUFFER: '-1' });
    expect(config.port).toBe(3001);
    expect(config.wsMaxBuffer).toBe(1_048_576);
  });
});
