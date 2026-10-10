import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { Client as PgClient } from 'pg';
import Redis from 'ioredis';
import { io, type Socket } from 'socket.io-client';

import { AppModule } from '../src/app.module';

/**
 * e2e 测试脚手架。
 *
 * 与 main.ts 保持同一套接线（前缀 / cookie / 校验管道 / 全局过滤器），
 * 差别只有两点：监听随机端口、静音日志。
 * 依赖：真实 PostgreSQL（+ Redis，缺了会退化为单实例模式但仍能跑）。
 */

export interface TestContext {
  app: INestApplication;
  baseUrl: string;
}

/** 探测依赖是否就绪：没起 Docker 时 e2e 应该被 skip 而不是红一片 */
export async function probeDependencies(): Promise<{ ok: boolean; reason: string }> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    return { ok: false, reason: 'DATABASE_URL 未配置（复制 .env 到 apps/api/.env）' };
  const pg = new PgClient({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  try {
    await pg.connect();
    await pg.query('SELECT 1');
  } catch (error) {
    await pg.end().catch(() => undefined);
    return { ok: false, reason: `PostgreSQL 不可用：${(error as Error).message}` };
  }
  await pg.end().catch(() => undefined);

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
      connectTimeout: 2000,
    });
    try {
      await redis.connect();
      await redis.ping();
    } catch (error) {
      await redis.disconnect();
      return { ok: false, reason: `Redis 不可用：${(error as Error).message}` };
    }
    await redis.quit().catch(() => redis.disconnect());
  }
  return { ok: true, reason: '' };
}

export async function startTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  // 与 main.ts 对齐的接线（校验统一走 zod 管道，不挂 class-validator 的 ValidationPipe）
  app.use(cookieParser());
  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.useLogger(false);
  await app.listen(0);

  const url = await app.getUrl();
  const baseUrl = url.replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');
  return { app, baseUrl };
}

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
  /** set-cookie 原始串（刷新令牌相关断言用） */
  setCookie: string | null;
}

export async function api<T = unknown>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
  return {
    status: response.status,
    body,
    headers: response.headers,
    setCookie: response.headers.get('set-cookie'),
  };
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}@e2e.test`;
}

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
  refreshCookie: string | null;
}

export async function registerUser(baseUrl: string, prefix = 'user'): Promise<TestUser> {
  const email = uniqueEmail(prefix);
  const response = await api<{ user: { id: string }; accessToken: string }>(
    baseUrl,
    '/api/auth/register',
    {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-password-123', displayName: prefix }),
    },
  );
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`注册失败：${response.status} ${JSON.stringify(response.body)}`);
  }
  return {
    id: response.body.user.id,
    email,
    accessToken: response.body.accessToken,
    refreshCookie: response.setCookie,
  };
}

/** 只取 cookie 的 name=value 部分，便于手动回放到请求头 */
export function cookiePair(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const pair = setCookie.split(';')[0];
  return pair && pair.length > 0 ? pair : null;
}

// ---------------------------------------------------------------------------
// Socket.IO 辅助
// ---------------------------------------------------------------------------

export async function connectSocket(
  baseUrl: string,
  accessToken: string | undefined,
): Promise<Socket> {
  const socket = io(baseUrl, {
    auth: accessToken ? { token: accessToken } : {},
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  // 把协议层的 error 事件打出来：否则用例只会"等 ack 超时"，看不到真正的原因
  socket.on('error', (payload: unknown) => {
    console.warn('[e2e] 收到 error 事件：', JSON.stringify(payload));
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接超时')), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}

/** 等一条指定事件（忽略不匹配的其它事件），超时抛错 */
export function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  options: { timeoutMs?: number; predicate?: (payload: T) => boolean } = {},
): Promise<T> {
  const { timeoutMs = 5000, predicate } = options;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`等待事件 ${event} 超时`));
    }, timeoutMs);
    const handler = (payload: T): void => {
      if (predicate && !predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

/** 收集一段时间内的事件（用于断言"没有发生"） */
export function collectEvents<T = unknown>(
  socket: Socket,
  event: string,
  windowMs = 300,
): Promise<T[]> {
  return new Promise<T[]>((resolve) => {
    const received: T[] = [];
    const handler = (payload: T): void => {
      received.push(payload);
    };
    socket.on(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve(received);
    }, windowMs);
  });
}

export async function closeSockets(sockets: Socket[]): Promise<void> {
  await Promise.all(
    sockets.map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (!socket.connected) {
            resolve();
            return;
          }
          socket.once('disconnect', () => resolve());
          socket.disconnect();
        }),
    ),
  );
}
