import {
  ERROR_CODES,
  parseClientEnvelope,
  type ClientEnvelope,
  type ClientEventName,
  type ErrorPayload,
} from '@collab/shared';

import type { AuthUser } from '../modules/auth/jwt-auth.guard';
import type { Socket } from 'socket.io';

/** socket.data 的形状（握手鉴权写入，业务处理只读） */
export interface RealtimeSocketData {
  user: AuthUser;
  /** 本连接已加入的房间；断线清理与权限收敛都靠它 */
  rooms: Set<string>;
}

export type AppSocket = Socket<
  Record<string, (...args: unknown[]) => void>,
  Record<string, (...args: unknown[]) => void>,
  Record<string, (...args: unknown[]) => void>,
  RealtimeSocketData
>;

export type ParseIncomingResult =
  { ok: true; envelope: ClientEnvelope } | { ok: false; error: ErrorPayload };

/**
 * 上行消息的双重校验（协议 §6.2）：
 *  1. 跑 `parseClientEnvelope`（shared 的判别联合 schema）——非法 payload / 未知事件名都被拒；
 *  2. 校验在哪个频道收到的消息就应该是哪个类型——否则客户端可以用
 *     `room:join` 频道塞一条 `shape:create` 绕过逐一处理器的参数假设。
 *
 * 永远不抛异常：非法消息只回 error 事件（VALIDATION_FAILED），连接不受影响。
 */
export function parseIncoming(body: unknown, expectedType: ClientEventName): ParseIncomingResult {
  if (typeof body !== 'object' || body === null) {
    return {
      ok: false,
      error: { code: ERROR_CODES.VALIDATION_FAILED, message: '消息体必须是对象' },
    };
  }
  const parsed = parseClientEnvelope(body);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: ERROR_CODES.VALIDATION_FAILED, message: '消息不符合协议' },
    };
  }
  if (parsed.envelope.type !== expectedType) {
    return {
      ok: false,
      error: {
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `频道与消息类型不一致：期望 ${expectedType}，收到 ${parsed.envelope.type}`,
      },
    };
  }
  return { ok: true, envelope: parsed.envelope };
}
