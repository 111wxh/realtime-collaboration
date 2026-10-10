import { CLIENT_EVENTS, makeClientEnvelope } from '@collab/shared';
import { describe, expect, it } from 'vitest';

import { parseIncoming } from './ws-message';

const BOARD = '00000000-0000-4000-8000-000000000001';
const SHAPE = '00000000-0000-4000-8000-000000000002';
const OP = '00000000-0000-4000-8000-000000000003';

describe('parseIncoming · 网关边界的协议校验', () => {
  it('合法消息通过（含 reqId 透传）', () => {
    const envelope = makeClientEnvelope(
      CLIENT_EVENTS.SHAPE_DELETE,
      { boardId: BOARD, shapeId: SHAPE, clientOpId: OP },
      { reqId: 'req-1' },
    );
    const result = parseIncoming(envelope, CLIENT_EVENTS.SHAPE_DELETE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.reqId).toBe('req-1');
    expect(result.envelope.payload).toEqual({ boardId: BOARD, shapeId: SHAPE, clientOpId: OP });
  });

  it('非对象（字符串/数字/null/数组）被拒，不抛异常', () => {
    for (const garbage of ['hello', 42, null, undefined, [1, 2, 3]]) {
      const result = parseIncoming(garbage, CLIENT_EVENTS.PING);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('信封字段缺失 / 协议版本不对被拒', () => {
    const bad = [
      { type: 'ping', ts: Date.now(), payload: {} }, // 缺 v
      { v: 2, type: 'ping', ts: Date.now(), payload: {} }, // 版本不对
      { v: 1, type: 'ping', payload: {} }, // 缺 ts
      { v: 1, type: 'unknown:event', ts: Date.now(), payload: {} }, // 未登记事件
    ];
    for (const body of bad) {
      const result = parseIncoming(body, CLIENT_EVENTS.PING);
      expect(result.ok).toBe(false);
    }
  });

  it('payload 违反 schema（缺字段 / NaN / 越界坐标）被拒', () => {
    const bad = [
      { v: 1, type: 'shape:delete', ts: Date.now(), payload: { boardId: BOARD, shapeId: SHAPE } },
      {
        v: 1,
        type: 'cursor:move',
        ts: Date.now(),
        payload: { boardId: BOARD, x: Number.NaN, y: 0 },
      },
      {
        v: 1,
        type: 'cursor:move',
        ts: Date.now(),
        payload: { boardId: BOARD, x: 1e9, y: 0 }, // 超过 MAX_COORD
      },
    ];
    for (const body of bad) {
      const expected =
        (body.type as string) === 'cursor:move'
          ? CLIENT_EVENTS.CURSOR_MOVE
          : CLIENT_EVENTS.SHAPE_DELETE;
      expect(parseIncoming(body, expected).ok).toBe(false);
    }
  });

  it('频道与消息类型不一致被拒（防止借频道绕过处理器假设）', () => {
    const envelope = makeClientEnvelope(CLIENT_EVENTS.PING, {});
    const result = parseIncoming(envelope, CLIENT_EVENTS.ROOM_JOIN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('不一致');
  });

  it('多余字段不会被当成合法输入的一部分（strip 后比较）', () => {
    const result = parseIncoming(
      { v: 1, type: 'ping', ts: Date.now(), payload: {}, evil: true },
      CLIENT_EVENTS.PING,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.payload).toEqual({});
  });
});
