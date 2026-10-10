import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

import type { IncomingMessage } from 'node:http';

/**
 * 令牌与随机码的公共部分：REST 与 WS 两条链路共用一套提取/哈希规则。
 */

/** 解析 `Authorization: Bearer xxx` */
export function extractBearerToken(headerValue: string | undefined | null): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match?.[1]?.trim() || null;
}

/**
 * WS 握手取 token：优先 `auth.token`（Socket.IO 官方姿势），
 * 兼容 `Authorization` 头（原生 ws 客户端/调试工具常用）。
 */
export function extractWsToken(handshake: {
  auth?: Record<string, unknown>;
  headers?: IncomingMessage['headers'];
}): string | null {
  const fromAuth = handshake.auth?.token;
  if (typeof fromAuth === 'string' && fromAuth.trim()) return fromAuth.trim();
  const header = handshake.headers?.authorization;
  return extractBearerToken(typeof header === 'string' ? header : undefined);
}

/** 刷新令牌只存哈希：库被读走也拿不到能用的令牌 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 生成不透明刷新令牌（高熵随机串，无需签名即可防伪造） */
export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

/** 8 位邀请码：去掉易混淆的 I/O/0/1 的 32 字符表，8 位约 1.1e12 组合 */
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateInviteCode(length = 8): string {
  // randomInt 是 CSPRNG：避免可预测的邀请码被枚举
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  }
  return code;
}

export function newRequestId(): string {
  return randomUUID();
}
