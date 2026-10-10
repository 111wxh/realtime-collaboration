import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CLIENT_EVENTS, SERVER_EVENTS } from './events';
import { ERROR_CODES, ErrorCodeSchema } from './errors';
import {
  MAX_COORD,
  clientSchemas,
  makeClientEnvelope,
  makeServerEnvelope,
  parseClientEnvelope,
  parseServerEnvelope,
  serverSchemas,
  type Shape,
} from './protocol';

const uuid = () => randomUUID();

function makeShape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: uuid(),
    boardId: uuid(),
    type: 'rect',
    x: 10,
    y: 20,
    w: 100,
    h: 60,
    rotation: 0,
    zIndex: 1,
    style: { stroke: '#111', fill: '#eee', strokeWidth: 2 },
    data: {},
    version: 1,
    createdBy: uuid(),
    deletedAt: null,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('事件表', () => {
  it('客户端事件表覆盖计划书 §6.3 的 9 个上行事件', () => {
    expect(Object.keys(clientSchemas)).toEqual(
      expect.arrayContaining([
        'room:join',
        'room:leave',
        'shape:create',
        'shape:update',
        'shape:delete',
        'shape:batch',
        'cursor:move',
        'board:sync',
        'ping',
      ]),
    );
    expect(Object.keys(clientSchemas)).toHaveLength(9);
  });

  it('服务端事件表覆盖计划书 §6.4 的下行事件', () => {
    expect(Object.keys(serverSchemas)).toHaveLength(13);
    expect(Object.keys(serverSchemas)).toContain(SERVER_EVENTS.ERROR);
  });

  it('错误码 schema 与常量一致', () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(ErrorCodeSchema.safeParse('NOT_A_REAL_CODE').success).toBe(false);
  });
});

describe('parseClientEnvelope', () => {
  it('合法消息解析通过并保留 reqId', () => {
    const envelope = makeClientEnvelope(
      CLIENT_EVENTS.SHAPE_CREATE,
      { boardId: uuid(), shape: makeShape(), clientOpId: uuid() },
      { reqId: 'req-1' },
    );

    const result = parseClientEnvelope(envelope);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.type).toBe('shape:create');
      expect(result.envelope.reqId).toBe('req-1');
      if (result.envelope.type === 'shape:create') {
        expect(result.envelope.payload.shape.type).toBe('rect');
      }
    }
  });

  it('未知事件名被拒', () => {
    const result = parseClientEnvelope({ v: 1, type: 'shape:nuke', ts: 1, payload: {} });
    expect(result.ok).toBe(false);
  });

  it('payload 缺字段被拒', () => {
    const result = parseClientEnvelope({
      v: 1,
      type: 'shape:create',
      ts: 1,
      payload: { boardId: uuid() },
    });
    expect(result.ok).toBe(false);
  });

  it('NaN 坐标被拒', () => {
    const envelope = makeClientEnvelope(CLIENT_EVENTS.SHAPE_CREATE, {
      boardId: uuid(),
      shape: makeShape(),
      clientOpId: uuid(),
    });
    const broken = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
    const payload = broken.payload as Record<string, unknown>;
    const shape = payload.shape as Record<string, unknown>;
    shape.x = Number.NaN;
    expect(parseClientEnvelope(broken).ok).toBe(false);
  });

  it('超出坐标上界的恶意数值被拒', () => {
    const envelope = makeClientEnvelope(CLIENT_EVENTS.SHAPE_CREATE, {
      boardId: uuid(),
      shape: makeShape(),
      clientOpId: uuid(),
    });
    const broken = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
    const payload = broken.payload as Record<string, unknown>;
    const shape = payload.shape as Record<string, unknown>;
    shape.x = MAX_COORD + 1;
    expect(parseClientEnvelope(broken).ok).toBe(false);
  });

  it('空 patch 的 update 被拒', () => {
    const result = parseClientEnvelope({
      v: 1,
      type: 'shape:update',
      ts: 1,
      payload: { boardId: uuid(), shapeId: uuid(), patch: {}, baseVersion: 1, clientOpId: uuid() },
    });
    expect(result.ok).toBe(false);
  });

  it('合法的 update patch 通过', () => {
    const envelope = makeClientEnvelope(CLIENT_EVENTS.SHAPE_UPDATE, {
      boardId: uuid(),
      shapeId: uuid(),
      patch: { x: 5, y: 6 },
      baseVersion: 1,
      clientOpId: uuid(),
    });
    const result = parseClientEnvelope(envelope);
    expect(result.ok).toBe(true);
    if (result.ok && result.envelope.type === 'shape:update') {
      expect(result.envelope.payload.baseVersion).toBe(1);
    }
  });
});

describe('parseServerEnvelope', () => {
  it('board:state 快照解析通过', () => {
    const envelope = makeServerEnvelope(SERVER_EVENTS.BOARD_STATE, {
      boardId: uuid(),
      seq: 42,
      shapes: [makeShape()],
    });
    expect(parseServerEnvelope(envelope).ok).toBe(true);
  });

  it('shape:ack 携带 serverShape 解析通过', () => {
    const envelope = makeServerEnvelope(SERVER_EVENTS.SHAPE_ACK, {
      reqId: 'r1',
      clientOpId: uuid(),
      seq: 7,
      serverShape: makeShape({ version: 2 }),
    });
    const result = parseServerEnvelope(envelope);
    expect(result.ok).toBe(true);
    if (result.ok && result.envelope.type === 'shape:ack') {
      expect(result.envelope.payload.serverShape?.version).toBe(2);
    }
  });

  it('shape:rejected 携带原因解析通过', () => {
    const envelope = makeServerEnvelope(SERVER_EVENTS.SHAPE_REJECTED, {
      reqId: 'r2',
      clientOpId: uuid(),
      reason: ERROR_CODES.VERSION_CONFLICT,
      serverShape: makeShape({ version: 5 }),
    });
    expect(parseServerEnvelope(envelope).ok).toBe(true);
  });

  it('服务端信封不能塞未知 payload', () => {
    expect(
      parseServerEnvelope({ v: 1, type: 'presence:left', ts: 1, payload: {} }).ok,
    ).toBe(false);
  });
});
