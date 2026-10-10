/**
 * 同步内核单测：乐观更新、ack 转正、拒绝回滚与重放、seq 对齐、乱序缓冲、
 * 陈旧快照丢弃、pending 队列降级、重连补发。
 *
 * 这些用例就是"断线 30s 恢复后两端一致""重复 clientOpId 不产生副作用"
 * 这类验收标准在前端侧的可执行版本。
 */
import type { Shape, ShapeOp } from '@collab/shared';
import { describe, expect, it } from 'vitest';

import { BOARD_ID, makeShape, testId } from '../board/testFixtures';
import type { LocalOpSpec, SyncEffect, SyncState, UndoOpTemplate } from './sync-core';
import {
  initialSyncState,
  MAX_PENDING,
  syncReduce,
  type AnySyncAction,
  type SyncResult,
} from './sync-core';

const BOARD = BOARD_ID;

/** 把 reducer 串起来跑，方便连续断言 */
class Harness {
  state: SyncState = initialSyncState(BOARD);

  effects: SyncEffect[] = [];

  dispatch(action: AnySyncAction): this {
    const result: SyncResult = syncReduce(this.state, action);
    this.state = result.state;
    this.effects.push(...result.effects);
    return this;
  }

  /** 发送一批本地操作（一个事务） */
  commit(ops: LocalOpSpec[], label = 'test', txId = testId()): this {
    return this.dispatch({ kind: 'local-ops', ops, txId, label });
  }

  /** 取出并清空累计的副作用（便于分段断言） */
  takeEffects(): SyncEffect[] {
    const out = this.effects;
    this.effects = [];
    return out;
  }

  /** 已发出的 op（send 副作用里收集） */
  get sent(): ShapeOp[] {
    return this.effects
      .filter((effect): effect is Extract<SyncEffect, { kind: 'send' }> => effect.kind === 'send')
      .flatMap((effect) => effect.ops);
  }

  notices(): string[] {
    return this.effects
      .filter(
        (effect): effect is Extract<SyncEffect, { kind: 'notice' }> => effect.kind === 'notice',
      )
      .map((effect) => effect.text);
  }

  scope(): string[] {
    return this.effects
      .filter((effect): effect is Extract<SyncEffect, { kind: 'sync' }> => effect.kind === 'sync')
      .map((effect) => `sync:${effect.sinceSeq}`);
  }
}

function ackPayload(
  clientOpId: string,
  serverShape: Shape | null,
  seq?: number,
): { reqId: string; clientOpId: string; seq?: number; serverShape: Shape | null } {
  return { reqId: testId(), clientOpId, seq, serverShape };
}

describe('乐观更新与 ack 转正', () => {
  it('本地创建立即出现在视图里，并排队等待确认', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 10, y: 10, w: 100, h: 60 });
    h.commit([{ opType: 'create', shape }], '创建图形');

    expect(h.state.shapes[shape.id]?.x).toBe(10);
    expect(h.state.pending).toHaveLength(1);
    expect(h.state.pending[0]?.status).toBe('queued');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.opType).toBe('create');
    // 撤销条目同时落袋
    const entry = h.takeEffects().find((e) => e.kind === 'undo-entry');
    expect(entry?.kind === 'undo-entry' ? entry.entry.label : '').toBe('创建图形');
    expect(entry?.kind === 'undo-entry' ? entry.entry.items[0]?.inverse : undefined).toEqual({
      opType: 'delete',
      shapeId: shape.id,
    });
  });

  it('ack 用 serverShape 覆盖权威值（version / zIndex 都归服务端）', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', zIndex: 3 });
    h.commit([{ opType: 'create', shape }]);
    const clientOpId = h.sent[0]!.clientOpId;
    h.takeEffects();

    const authoritative: Shape = { ...shape, zIndex: 7, version: 1 };
    h.dispatch({ kind: 'sent', clientOpIds: [clientOpId] });
    h.dispatch({ kind: 'ack', payload: ackPayload(clientOpId, authoritative, 1) });

    expect(h.state.pending).toHaveLength(0);
    expect(h.state.shapes[shape.id]?.zIndex).toBe(7);
    expect(h.state.seq).toBe(1);
    expect(h.state.stats.acked).toBe(1);
  });

  it('重复 ack 不会二次扣减 pending（幂等）', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect' });
    h.commit([{ opType: 'create', shape }]);
    const clientOpId = h.sent[0]!.clientOpId;
    h.dispatch({ kind: 'ack', payload: ackPayload(clientOpId, shape, 1) });
    h.takeEffects();
    h.dispatch({ kind: 'ack', payload: ackPayload(clientOpId, shape, 1) });
    expect(h.state.pending).toHaveLength(0);
    expect(h.state.stats.acked).toBe(1);
  });

  it('ack 之后仍然 pending 的后续操作会重新叠到权威状态之上', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 0, y: 0, w: 100, h: 100 });
    h.commit([{ opType: 'create', shape }]);
    const createId = h.sent[0]!.clientOpId;
    h.commit([{ opType: 'update', shapeId: shape.id, patch: { x: 40, y: 40 } }]);
    const updateId = h.sent[1]!.clientOpId;
    h.takeEffects();

    // 服务端确认 create 时只带原始坐标
    h.dispatch({ kind: 'ack', payload: ackPayload(createId, shape, 1) });
    // 本地仍应看到 update 的乐观效果
    expect(h.state.shapes[shape.id]?.x).toBe(40);
    expect(h.state.pending).toHaveLength(1);

    // update 也确认后，权威值落地
    const finalShape = { ...shape, x: 40, y: 40, version: 2 };
    h.dispatch({ kind: 'ack', payload: ackPayload(updateId, finalShape, 2) });
    expect(h.state.shapes[shape.id]?.x).toBe(40);
    expect(h.state.seq).toBe(2);
  });
});

describe('拒绝回滚', () => {
  it('create 被拒（无 serverShape）→ 回滚为软删除（本地视图不再显示）', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect' });
    h.commit([{ opType: 'create', shape }]);
    const clientOpId = h.sent[0]!.clientOpId;
    h.takeEffects();

    h.dispatch({
      kind: 'reject',
      payload: { reqId: testId(), clientOpId, reason: 'VALIDATION_FAILED', serverShape: null },
    });
    // 回滚走的是"逆操作"（create 的逆 = 软删除），与服务器的软删除模型保持一致
    expect(h.state.shapes[shape.id]?.deletedAt).not.toBeNull();
    expect(h.state.pending).toHaveLength(0);
    expect(h.notices().length).toBe(1);
  });

  it('update 被拒且服务端给了 serverShape → 以服务端状态为准', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 0, y: 0, w: 100, h: 100, version: 1 });
    h.commit([{ opType: 'create', shape }]);
    const createId = h.sent[0]!.clientOpId;
    h.dispatch({ kind: 'ack', payload: ackPayload(createId, shape, 1) });
    h.commit([{ opType: 'update', shapeId: shape.id, patch: { x: 500 } }]);
    const updateId = h.sent[1]!.clientOpId;
    expect(h.state.shapes[shape.id]?.x).toBe(500);
    h.takeEffects();

    const authoritative: Shape = { ...shape, x: 42, version: 9 };
    h.dispatch({
      kind: 'reject',
      payload: {
        reqId: testId(),
        clientOpId: updateId,
        reason: 'FORBIDDEN',
        serverShape: authoritative,
      },
    });
    expect(h.state.shapes[shape.id]?.x).toBe(42);
    expect(h.state.shapes[shape.id]?.version).toBe(9);
    // 撤销条目里这一项被摘掉
    const discard = h.effects.find((effect) => effect.kind === 'undo-discard');
    expect(discard?.kind === 'undo-discard' ? discard.clientOpId : '').toBe(updateId);
  });
});

describe('VERSION_CONFLICT 重放', () => {
  it('以 serverShape 为新基底重发同一份 patch，并更新 baseVersion', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 0, y: 0, w: 100, h: 100, version: 1 });
    h.commit([{ opType: 'create', shape }]);
    const createId = h.sent[0]!.clientOpId;
    h.dispatch({ kind: 'ack', payload: ackPayload(createId, shape, 1) });
    h.commit([{ opType: 'update', shapeId: shape.id, patch: { x: 300 } }]);
    const updateId = h.sent[1]!.clientOpId;
    h.takeEffects();

    // 别人先改了同一个图形 → 我们的 baseVersion 落后
    const authoritative: Shape = { ...shape, x: 10, y: 20, version: 5 };
    h.dispatch({
      kind: 'reject',
      payload: {
        reqId: testId(),
        clientOpId: updateId,
        reason: 'VERSION_CONFLICT',
        serverShape: authoritative,
      },
    });

    const resend = h.sent;
    expect(resend).toHaveLength(1);
    expect(resend[0]!.opType).toBe('update');
    expect(resend[0]!.patch).toEqual({ x: 300 });
    expect(resend[0]!.clientOpId).not.toBe(updateId);
    // 本地视图 = 服务端基底 + 我们的 patch
    expect(h.state.shapes[shape.id]?.x).toBe(300);
    expect(h.state.shapes[shape.id]?.y).toBe(20);
    expect(h.state.pending).toHaveLength(1);
    expect(h.state.pending[0]?.baseVersion).toBe(5);
    expect(h.state.pending[0]?.attempts).toBe(1);
    // 撤销条目被替换成新的 clientOpId
    const replace = h.effects.find((effect) => effect.kind === 'undo-replace');
    expect(replace?.kind === 'undo-replace' ? replace.fromClientOpId : '').toBe(updateId);
  });

  it('重放超过上限后放弃，并提示用户', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', version: 1 });
    h.commit([{ opType: 'create', shape }]);
    const createId = h.sent[0]!.clientOpId;
    h.dispatch({ kind: 'ack', payload: ackPayload(createId, shape, 1) });
    h.takeEffects();

    // 同一个 op 反复撞版本冲突：每次拒绝后内核会以 serverShape 为新基底重发
    h.commit([{ opType: 'update', shapeId: shape.id, patch: { x: 1 } }]);
    let rejections = 0;
    while (rejections < 6) {
      const pendingOp = h.state.pending[h.state.pending.length - 1];
      if (!pendingOp) break;
      h.dispatch({
        kind: 'reject',
        payload: {
          reqId: testId(),
          clientOpId: pendingOp.clientOpId,
          reason: 'VERSION_CONFLICT',
          serverShape: { ...shape, x: 100 + rejections, version: 100 + rejections },
        },
      });
      rejections += 1;
    }
    expect(rejections).toBe(4); // 首次 + 3 次重放，第 4 次放弃
    expect(h.state.pending).toHaveLength(0);
    expect(h.notices().some((text) => text.includes('放弃'))).toBe(true);
    // 放弃后本地视图回到服务端权威值
    expect(h.state.shapes[shape.id]?.version).toBe(103);
  });
});

describe('seq 对齐与检漏', () => {
  const op = (seq: number, shapeId: string, patch = { x: seq }): ShapeOp => ({
    opType: 'update',
    shapeId,
    patch,
    clientOpId: testId(),
    seq,
  });

  it('连续广播按序应用，seq 单调推进', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 0 });
    h.dispatch({ kind: 'board-state', payload: { boardId: BOARD, seq: 0, shapes: [shape] } });
    h.dispatch({ kind: 'authority', seq: 1, op: op(1, shape.id, { x: 1 }) });
    h.dispatch({ kind: 'authority', seq: 2, op: op(2, shape.id, { x: 2 }) });
    expect(h.state.seq).toBe(2);
    expect(h.state.shapes[shape.id]?.x).toBe(2);
    expect(h.state.gap).toEqual({});
  });

  it('seq 断档：消息不丢弃（先进缓冲），并立刻请求 board:sync', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 0 });
    h.dispatch({ kind: 'board-state', payload: { boardId: BOARD, seq: 1, shapes: [shape] } });
    h.takeEffects();

    // 期望 seq 2，先来了 4
    h.dispatch({ kind: 'authority', seq: 4, op: op(4, shape.id, { x: 40 }) });
    expect(h.state.gap[4]).toBeDefined();
    expect(h.scope()).toEqual(['sync:1']);
    expect(h.state.seq).toBe(1);

    // 补齐 2、3 之后，缓冲里的 4 会被按序重放
    h.dispatch({
      kind: 'board-ops',
      payload: {
        boardId: BOARD,
        fromSeq: 2,
        ops: [op(2, shape.id, { x: 20 }), op(3, shape.id, { x: 30 })],
        latestSeq: 4,
      },
    });
    expect(h.state.seq).toBe(4);
    expect(h.state.gap).toEqual({});
    expect(h.state.shapes[shape.id]?.x).toBe(40);
  });

  it('补齐后仍有洞会再次请求（不越洞推进）', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 0 });
    h.dispatch({ kind: 'board-state', payload: { boardId: BOARD, seq: 1, shapes: [shape] } });
    h.takeEffects();
    h.dispatch({ kind: 'authority', seq: 5, op: op(5, shape.id) });
    h.takeEffects();

    h.dispatch({
      kind: 'board-ops',
      payload: { boardId: BOARD, fromSeq: 2, ops: [op(2, shape.id, { x: 2 })], latestSeq: 5 },
    });
    expect(h.state.seq).toBe(2);
    expect(h.state.gap[5]).toBeDefined();
    expect(h.scope()).toEqual(['sync:2']);
  });

  it('board:ops 幂等重放：重复的 op 不会二次应用', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 0 });
    h.dispatch({ kind: 'board-state', payload: { boardId: BOARD, seq: 0, shapes: [shape] } });
    const ops = [op(1, shape.id, { x: 10 }), op(2, shape.id, { x: 20 })];
    h.dispatch({ kind: 'board-ops', payload: { boardId: BOARD, fromSeq: 1, ops, latestSeq: 2 } });
    expect(h.state.seq).toBe(2);
    expect(h.state.shapes[shape.id]?.x).toBe(20);

    // 同一条增量重放一遍：seq 已经推进，全部跳过
    h.dispatch({ kind: 'board-ops', payload: { boardId: BOARD, fromSeq: 1, ops, latestSeq: 2 } });
    expect(h.state.seq).toBe(2);
    expect(h.state.shapes[shape.id]?.x).toBe(20);
  });

  it('重复的广播 seq 直接忽略', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 0 });
    h.dispatch({ kind: 'board-state', payload: { boardId: BOARD, seq: 0, shapes: [shape] } });
    h.dispatch({ kind: 'authority', seq: 1, op: op(1, shape.id, { x: 11 }) });
    h.dispatch({ kind: 'authority', seq: 1, op: op(1, shape.id, { x: 999 }) });
    expect(h.state.shapes[shape.id]?.x).toBe(11);
  });

  it('board:ops 缺 seq 时按 fromSeq 推导', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 0 });
    h.dispatch({ kind: 'board-state', payload: { boardId: BOARD, seq: 0, shapes: [shape] } });
    const bare: ShapeOp = {
      opType: 'update',
      shapeId: shape.id,
      patch: { x: 3 },
      clientOpId: testId(),
    };
    h.dispatch({
      kind: 'board-ops',
      payload: { boardId: BOARD, fromSeq: 1, ops: [bare], latestSeq: 1 },
    });
    expect(h.state.seq).toBe(1);
    expect(h.state.shapes[shape.id]?.x).toBe(3);
  });

  it('ack 的 seq 也用于推进（服务端不回自己广播时靠它对齐）', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect' });
    h.commit([{ opType: 'create', shape }]);
    const opId = h.sent[0]!.clientOpId;
    h.takeEffects();
    h.dispatch({ kind: 'ack', payload: ackPayload(opId, shape, 1) });
    expect(h.state.seq).toBe(1);
  });

  it('ack 带了跳号的 seq：不越洞推进，改为请求补齐', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect' });
    h.commit([{ opType: 'create', shape }]);
    const opId = h.sent[0]!.clientOpId;
    h.takeEffects();
    h.dispatch({ kind: 'ack', payload: ackPayload(opId, shape, 5) });
    expect(h.state.seq).toBe(0);
    expect(h.scope()).toEqual(['sync:0']);
  });
});

describe('全量快照', () => {
  it('陈旧快照（seq 小于本地）直接丢弃，不回退状态', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 50 });
    h.dispatch({ kind: 'board-state', payload: { boardId: BOARD, seq: 5, shapes: [shape] } });
    h.takeEffects();

    h.dispatch({
      kind: 'board-state',
      payload: { boardId: BOARD, seq: 2, shapes: [makeShape({ type: 'rect', x: -999 })] },
    });
    expect(h.state.seq).toBe(5);
    expect(Object.values(h.state.shapes)).toHaveLength(1);
    expect(h.notices().some((text) => text.includes('过期'))).toBe(true);
  });

  it('接受快照后把 pending 的乐观效果重新叠上去', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 0, y: 0, w: 100, h: 100 });
    h.commit([{ opType: 'create', shape }]);
    h.commit([{ opType: 'update', shapeId: shape.id, patch: { x: 777 } }]);
    h.takeEffects();

    // 重连后服务端下发快照（还没有我们的两次写操作）
    h.dispatch({
      kind: 'board-state',
      payload: { boardId: BOARD, seq: 9, shapes: [shape] },
    });
    expect(h.state.shapes[shape.id]?.x).toBe(777);
    expect(h.state.pending).toHaveLength(2);
    expect(h.state.seq).toBe(9);
  });

  it('快照之后到达的更旧缓冲会被清掉，更新的会被重放', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 0 });
    h.dispatch({
      kind: 'authority',
      seq: 7,
      op: { opType: 'update', shapeId: shape.id, patch: { x: 70 }, clientOpId: testId(), seq: 7 },
    });
    expect(h.state.gap[7]).toBeDefined();
    h.takeEffects();

    h.dispatch({ kind: 'board-state', payload: { boardId: BOARD, seq: 9, shapes: [shape] } });
    expect(h.state.gap).toEqual({});
    expect(h.state.seq).toBe(9);
  });
});

describe('pending 队列与断线', () => {
  it('重连后把未确认的操作全部补发', () => {
    const h = new Harness();
    const rect = makeShape({ type: 'rect' });
    h.commit([{ opType: 'create', shape: rect }]);
    h.commit([{ opType: 'update', shapeId: rect.id, patch: { x: 5 } }]);
    h.dispatch({ kind: 'sent', clientOpIds: h.sent.map((op) => op.clientOpId) });
    h.takeEffects();

    h.dispatch({ kind: 'connected' });
    expect(h.sent).toHaveLength(2);
    expect(h.state.pending.every((item) => item.status === 'queued')).toBe(true);
  });

  it('队列超过上限时合并同一图形的未发送操作（只发最终态）', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect' });
    h.commit([{ opType: 'create', shape }]);
    const shapeId = shape.id;

    // 塞满队列（断线期间所有 op 都是 queued）
    for (let i = 0; i < MAX_PENDING - 1; i += 1) {
      h.commit([{ opType: 'update', shapeId, patch: { x: i } }]);
    }
    expect(h.state.pending).toHaveLength(MAX_PENDING);
    h.takeEffects();

    // 第 501 条：触发降级，同一图形的积压 op 被折叠成一条
    h.commit([{ opType: 'update', shapeId, patch: { x: 9999 } }]);
    expect(h.state.stats.degraded).toBe(MAX_PENDING);
    expect(h.state.pending).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    // 折叠后的 op 无论是 create（带最终几何）还是 update（带合并 patch），值都必须是最终态
    const mergedOp = h.sent[0]!;
    expect(mergedOp.shape?.x ?? mergedOp.patch?.x).toBe(9999);
    expect(h.state.shapes[shapeId]?.x).toBe(9999);
  });

  it('降级时的合并语义：create + 后续 update 折叠成带最终几何的 create', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 0, y: 0 });
    // 填满队列：同一个图形交替 create / update，逼近上限
    for (let i = 0; i < MAX_PENDING; i += 1) {
      h.commit([
        i % 2 === 0
          ? { opType: 'create', shape }
          : { opType: 'update', shapeId: shape.id, patch: { x: i } },
      ]);
    }
    h.takeEffects();
    const before = h.state.pending.length;

    h.commit([{ opType: 'update', shapeId: shape.id, patch: { y: 77 } }]);
    const merged = h.sent;
    expect(merged).toHaveLength(1);
    // create 与 update 折叠后仍是 create（携带最终几何），服务端一次落库即最终态，
    // 每个字段留下的是"最新值"：x 来自最后一次 update，y 来自本次
    expect(merged[0]?.opType).toBe('create');
    expect(merged[0]?.shape?.x).toBe(MAX_PENDING - 1);
    expect(merged[0]?.shape?.y).toBe(77);
    expect(h.state.pending.length).toBeLessThan(before);
  });

  it('断线期间操作只留在队列，不产生任何发送', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect' });
    h.commit([{ opType: 'create', shape }]);
    // 模拟 manager 在离线时不执行 send，仅记录 sent 状态
    expect(h.state.pending[0]?.status).toBe('queued');
    expect(h.state.pending).toHaveLength(1);
  });
});

describe('撤销用的逆操作', () => {
  it('update 的逆操作回填旧值', () => {
    const h = new Harness();
    const shape = makeShape({
      type: 'rect',
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      style: { stroke: '#111', strokeWidth: 2 },
    });
    h.commit([{ opType: 'create', shape }]);
    h.takeEffects();
    h.commit([
      { opType: 'update', shapeId: shape.id, patch: { x: 100, style: { stroke: '#222' } } },
    ]);
    const entry = h.takeEffects().find((e) => e.kind === 'undo-entry');
    const inverse = entry?.kind === 'undo-entry' ? entry.entry.items[0]!.inverse : null;
    expect(inverse).toEqual({
      opType: 'update',
      shapeId: shape.id,
      patch: { x: 1, style: { stroke: '#111', strokeWidth: 2 } },
    });
  });

  it('delete 的逆操作是带完整图形的 restore', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect' });
    h.commit([{ opType: 'create', shape }]);
    h.dispatch({ kind: 'ack', payload: ackPayload(h.sent[0]!.clientOpId, shape, 1) });
    h.takeEffects();

    h.commit([{ opType: 'delete', shapeId: shape.id }]);
    const entry = h.takeEffects().find((e) => e.kind === 'undo-entry');
    const inverse = (
      entry?.kind === 'undo-entry' ? entry.entry.items[0]!.inverse : null
    ) as UndoOpTemplate | null;
    expect(inverse?.opType).toBe('restore');
    expect(inverse?.shape?.id).toBe(shape.id);
    // 本地视图里图形被标记软删除
    expect(h.state.shapes[shape.id]?.deletedAt).not.toBeNull();
  });

  it('reorder 的逆操作回到原 zIndex', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', zIndex: 2 });
    h.commit([{ opType: 'create', shape }]);
    h.dispatch({ kind: 'ack', payload: ackPayload(h.sent[0]!.clientOpId, shape, 1) });
    h.takeEffects();
    h.commit([{ opType: 'reorder', shapeId: shape.id, zIndex: 9 }]);
    const entry = h.takeEffects().find((e) => e.kind === 'undo-entry');
    const inverse = entry?.kind === 'undo-entry' ? entry.entry.items[0]!.inverse : null;
    expect(inverse).toEqual({ opType: 'update', shapeId: shape.id, patch: { zIndex: 2 } });
    expect(h.state.shapes[shape.id]?.zIndex).toBe(9);
  });
});

describe('批量（shape:batch）的 ack 与拒绝', () => {
  /** 多选移动：一次提交两个 shape 的 update（同一个 txId） */
  function commitTwoMoves(h: Harness): { first: Shape; second: Shape } {
    const first = makeShape({ type: 'rect', x: 0, y: 0 });
    const second = makeShape({ type: 'rect', x: 100, y: 0 });
    h.commit([{ opType: 'create', shape: first }]);
    h.dispatch({ kind: 'ack', payload: ackPayload(h.sent[0]!.clientOpId, first, 1) });
    h.commit([{ opType: 'create', shape: second }]);
    h.dispatch({ kind: 'ack', payload: ackPayload(h.sent[1]!.clientOpId, second, 2) });
    h.takeEffects();
    h.commit(
      [
        { opType: 'update', shapeId: first.id, patch: { x: 10 } },
        { opType: 'update', shapeId: second.id, patch: { x: 110 } },
      ],
      '移动图形',
    );
    return { first, second };
  }

  it('batch ack 只带第一条 op 的 clientOpId + seqs：所有子 op 都要摘掉', () => {
    const h = new Harness();
    commitTwoMoves(h);
    const [op1, op2] = h.sent;
    expect(h.state.pending).toHaveLength(2);
    h.takeEffects();
    const ackedBefore = h.state.stats.acked;

    // 服务端的形状：clientOpId = 第一条，逐条 seq 在 seqs 里，serverShape 为 null
    h.dispatch({
      kind: 'ack',
      payload: {
        reqId: testId(),
        clientOpId: op1!.clientOpId,
        seqs: { [op1!.clientOpId]: 3, [op2!.clientOpId]: 4 },
        serverShape: null,
      },
    });
    expect(h.state.pending).toHaveLength(0);
    expect(h.state.seq).toBe(4); // seqs 连续 → 推进到最大
    expect(h.state.stats.acked).toBe(ackedBefore + 2);
  });

  it('batch 被拒（整批原子）→ 整个事务按逆操作回滚', () => {
    const h = new Harness();
    const { first, second } = commitTwoMoves(h);
    const [op1] = h.sent;
    expect(h.state.shapes[first.id]?.x).toBe(10);
    expect(h.state.shapes[second.id]?.x).toBe(110);
    h.takeEffects();

    h.dispatch({
      kind: 'reject',
      payload: {
        reqId: testId(),
        clientOpId: op1!.clientOpId, // 服务端只报第一条
        reason: 'VALIDATION_FAILED',
        serverShape: null,
      },
    });
    // 两个图形都回到操作前的位置，pending 清空
    expect(h.state.shapes[first.id]?.x).toBe(0);
    expect(h.state.shapes[second.id]?.x).toBe(100);
    expect(h.state.pending).toHaveLength(0);
    // 两条 undo-discard（撤销条目整条摘掉）
    const discards = h.effects.filter((effect) => effect.kind === 'undo-discard');
    expect(discards).toHaveLength(2);
    expect(h.notices().some((text) => text.includes('整体撤销'))).toBe(true);
  });

  it('batch 拒绝不会连带回滚其它事务的乐观操作', () => {
    const h = new Harness();
    const { first, second } = commitTwoMoves(h);
    const [op1] = h.sent;
    // 另一个独立事务（单条删除）仍在 pending
    h.commit([{ opType: 'delete', shapeId: second.id }]);
    const deleteOp = h.sent[h.sent.length - 1]!;
    h.takeEffects();

    h.dispatch({
      kind: 'reject',
      payload: {
        reqId: testId(),
        clientOpId: op1!.clientOpId,
        reason: 'FORBIDDEN',
        serverShape: null,
      },
    });
    // 两个 update 被回滚，但 delete 的乐观效果保留
    expect(h.state.shapes[first.id]?.x).toBe(0);
    expect(h.state.shapes[second.id]?.deletedAt).not.toBeNull();
    expect(h.state.pending.map((p) => p.clientOpId)).toEqual([deleteOp.clientOpId]);
  });
});

describe('reset 与统计', () => {
  it('reset 清空所有本地推算状态', () => {
    const h = new Harness();
    h.commit([{ opType: 'create', shape: makeShape({ type: 'rect' }) }]);
    h.dispatch({ kind: 'reset', boardId: BOARD });
    expect(h.state.shapes).toEqual({});
    expect(h.state.pending).toEqual([]);
    expect(h.state.seq).toBe(0);
  });

  it('统计字段能反映 ack / reject / 补齐次数', () => {
    const h = new Harness();
    const shape = makeShape({ type: 'rect', x: 0 });
    h.dispatch({
      kind: 'authority',
      seq: 3,
      op: { opType: 'update', shapeId: shape.id, patch: { x: 1 }, clientOpId: testId(), seq: 3 },
    });
    h.dispatch({
      kind: 'board-ops',
      payload: {
        boardId: BOARD,
        fromSeq: 1,
        ops: [1, 2, 3].map((seq) => ({
          opType: 'update' as const,
          shapeId: shape.id,
          patch: { x: seq },
          clientOpId: testId(),
          seq,
        })),
        latestSeq: 3,
      },
    });
    expect(h.state.stats.resyncs).toBeGreaterThanOrEqual(1);
    expect(h.state.seq).toBe(3);
  });
});
