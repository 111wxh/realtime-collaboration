import { describe, expect, it } from 'vitest';

import {
  cookiePair,
  probeDependencies,
  registerUser,
  startTestApp,
  api,
  uniqueEmail,
} from './e2e-helpers';

/**
 * 认证链路的 e2e：注册 / 重复邮箱 409 / 登录 / me / 刷新轮换 / 登出撤销。
 * 同样需要真实 PostgreSQL。
 */

const probe = await probeDependencies();

describe.skipIf(!probe.ok)(
  `认证接口（真实 PG）${probe.ok ? '' : ` · 已跳过：${probe.reason}`}`,
  () => {
    it('注册 → 登录 → me → 刷新 → 登出，语义与状态码正确', async () => {
      const { app, baseUrl } = await startTestApp();
      try {
        const email = uniqueEmail('auth');
        const password = 'auth-password-123';

        // 注册
        const registered = await api<{ user: { id: string; email: string }; accessToken: string }>(
          baseUrl,
          '/api/auth/register',
          {
            method: 'POST',
            body: JSON.stringify({ email, password, displayName: 'Auth 用户' }),
          },
        );
        expect(registered.status).toBe(201);
        expect(registered.body.accessToken.length).toBeGreaterThan(20);
        expect(registered.body.user.email).toBe(email);
        // 刷新令牌只以 httpOnly cookie 形式出现
        expect(registered.setCookie).toContain('refresh_token=');
        expect(registered.setCookie).toContain('HttpOnly');
        const cookie = cookiePair(registered.setCookie)!;

        // 重复注册 → 409 ALREADY_EXISTS（citext 大小写不敏感）
        const duplicated = await api<{ code: string }>(baseUrl, '/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email: email.toUpperCase(), password, displayName: 'dup' }),
        });
        expect(duplicated.status).toBe(409);
        expect(duplicated.body.code).toBe('ALREADY_EXISTS');

        // 密码错误 → 401，且不泄露账号是否存在（同一文案）
        const wrongPassword = await api<{ code: string; message: string }>(
          baseUrl,
          '/api/auth/login',
          { method: 'POST', body: JSON.stringify({ email, password: 'wrong-password' }) },
        );
        expect(wrongPassword.status).toBe(401);
        expect(wrongPassword.body.code).toBe('UNAUTHENTICATED');
        const unknownUser = await api<{ message: string }>(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: uniqueEmail('ghost'), password: 'whatever-123' }),
        });
        expect(unknownUser.status).toBe(401);
        expect(unknownUser.body.message).toBe(wrongPassword.body.message);

        // 登录
        const loggedIn = await api<{ user: { id: string }; accessToken: string }>(
          baseUrl,
          '/api/auth/login',
          { method: 'POST', body: JSON.stringify({ email, password }) },
        );
        expect(loggedIn.status).toBe(200);
        const accessToken = loggedIn.body.accessToken;
        expect(loggedIn.body.user.id).toBe(registered.body.user.id);

        // me：带 token 200，不带 401
        const me = await api<{ user: { email: string } }>(baseUrl, '/api/auth/me', {
          headers: { authorization: `Bearer ${accessToken}` },
        });
        expect(me.status).toBe(200);
        expect(me.body.user.email).toBe(email);
        const anonymous = await api<{ code: string }>(baseUrl, '/api/auth/me');
        expect(anonymous.status).toBe(401);
        expect(anonymous.body.code).toBe('UNAUTHENTICATED');

        // 刷新：拿到新 access token，且轮换出新 cookie
        const refreshed = await api<{ accessToken: string }>(baseUrl, '/api/auth/refresh', {
          method: 'POST',
          headers: { cookie },
        });
        expect(refreshed.status).toBe(200);
        const newCookie = cookiePair(refreshed.setCookie);
        expect(newCookie).not.toBe(cookie);
        const meWithNewToken = await api(baseUrl, '/api/auth/me', {
          headers: { authorization: `Bearer ${refreshed.body.accessToken}` },
        });
        expect(meWithNewToken.status).toBe(200);

        // 旧刷新令牌已撤销：重放直接失效
        const replay = await api<{ code: string }>(baseUrl, '/api/auth/refresh', {
          method: 'POST',
          headers: { cookie },
        });
        expect(replay.status).toBe(401);
        expect(replay.body.code).toBe('UNAUTHENTICATED');

        // 登出撤销当前刷新令牌
        const logout = await api(baseUrl, '/api/auth/logout', {
          method: 'POST',
          headers: { cookie: newCookie! },
        });
        expect(logout.status).toBe(204);
        const afterLogout = await api<{ code: string }>(baseUrl, '/api/auth/refresh', {
          method: 'POST',
          headers: { cookie: newCookie! },
        });
        expect(afterLogout.status).toBe(401);
      } finally {
        await app.close();
      }
    }, 60_000);

    it('输入校验：坏邮箱 / 短密码 → 400 VALIDATION_FAILED；不存在的邀请码 → 404', async () => {
      const { app, baseUrl } = await startTestApp();
      try {
        const badEmail = await api<{ code: string }>(baseUrl, '/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email: 'not-an-email', password: '12345678', displayName: 'x' }),
        });
        expect(badEmail.status).toBe(400);
        expect(badEmail.body.code).toBe('VALIDATION_FAILED');

        const shortPassword = await api<{ code: string }>(baseUrl, '/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email: uniqueEmail('short'), password: '123', displayName: 'x' }),
        });
        expect(shortPassword.status).toBe(400);
        expect(shortPassword.body.code).toBe('VALIDATION_FAILED');

        const user = await registerUser(baseUrl, 'joiner');
        const badCode = await api<{ code: string }>(baseUrl, '/api/rooms/join', {
          method: 'POST',
          headers: { authorization: `Bearer ${user.accessToken}` },
          body: JSON.stringify({ inviteCode: 'ZZZZZZZZ' }),
        });
        expect(badCode.status).toBe(404);
        expect(badCode.body.code).toBe('NOT_FOUND');
      } finally {
        await app.close();
      }
    }, 60_000);
  },
);

if (!probe.ok) {
  console.warn(`[e2e] 跳过认证接口套件：${probe.reason}`);
}
