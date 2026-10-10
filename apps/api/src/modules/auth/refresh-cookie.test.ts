import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../common/config';
import { REFRESH_COOKIE_PATH, refreshCookieOptions } from './auth.controller';

/**
 * 刷新 cookie 的 Secure 策略是"能不能登录"的开关，值得单测钉住：
 * 早期写法是 `NODE_ENV === 'production'`，全栈 compose（http://localhost + NODE_ENV=production）
 * 下浏览器会直接丢掉这个 cookie，刷新与登出全部失效。
 */
describe('refreshCookieOptions', () => {
  const baseEnv = { DATABASE_URL: 'postgresql://app:app@localhost:5433/collab' };

  it('未配置 COOKIE_SECURE 时跟随请求协议', () => {
    const config = loadConfig({ ...baseEnv, NODE_ENV: 'production' });
    expect(refreshCookieOptions(config, false).secure).toBe(false); // compose 的 http://localhost
    expect(refreshCookieOptions(config, true).secure).toBe(true); // HTTPS / 反代
  });

  it('COOKIE_SECURE 显式覆盖协议推断', () => {
    const forced = loadConfig({ ...baseEnv, COOKIE_SECURE: 'true' });
    expect(refreshCookieOptions(forced, false).secure).toBe(true);
    const off = loadConfig({ ...baseEnv, NODE_ENV: 'production', COOKIE_SECURE: '0' });
    expect(refreshCookieOptions(off, true).secure).toBe(false);
  });

  it('非法 COOKIE_SECURE 值按未配置处理', () => {
    const config = loadConfig({ ...baseEnv, COOKIE_SECURE: 'maybe' });
    expect(refreshCookieOptions(config, true).secure).toBe(true);
    expect(refreshCookieOptions(config, false).secure).toBe(false);
  });

  it('httpOnly / sameSite / path / maxAge 保持不变', () => {
    const config = loadConfig(baseEnv);
    const options = refreshCookieOptions(config, false);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe(REFRESH_COOKIE_PATH);
    expect(options.maxAge).toBe(config.refreshTokenTtlMs);
  });
});
