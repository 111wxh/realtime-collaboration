import { describe, expect, it } from 'vitest';

import { mergeShapePatch, shapeRowFromWire, toWireOp, toWireShape } from './board.mapper';
import { makeSeedShapeRow, makeShape, uid, BOARD_ID } from './board.fixtures';
import { replayOps } from './board.replay';
import type { OpRow } from './board.types';

describe('board.mapper', () => {
  it('toWireShape：BigInt/Date 转成协议类型（不会把 BigInt 漏进 JSON）', () => {
    const row = makeSeedShapeRow({
      id: uid(101),
      version: 7,
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      updatedAt: new Date('2026-01-02T03:04:06.000Z'),
      deletedAt: null,
    });
    const wire = toWireShape(row);
    expect(wire.version).toBe(7);
    expect(wire.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(wire.deletedAt).toBeNull();
    // 协议 schema 能过（这也是网关下发给客户端的前提）
    expect(() => JSON.stringify(wire)).not.toThrow();
  });

  it('toWireShape：style/data 缺省时补 {}，软删时带 deletedAt', () => {
    const row = makeSeedShapeRow({
      style: {},
      data: {},
      deletedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const wire = toWireShape(row);
    expect(wire.style).toEqual({});
    expect(wire.data).toEqual({});
    expect(wire.deletedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('shapeRowFromWire：version 强制为 1、createdBy 取服务端认定值（不信客户端）', () => {
    const wire = makeShape({ id: uid(101), version: 99, createdBy: uid(55) });
    const row = shapeRowFromWire(wire, uid(3));
    expect(row.version).toBe(1);
    expect(row.createdBy).toBe(uid(3));
    expect(row.deletedAt).toBeNull();
  });

  it('mergeShapePatch：标量覆盖 + style/data 浅合并 + version+1', () => {
    const current = {
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      rotation: 0,
      zIndex: 0,
      style: { stroke: '#000000', fill: '#ffffff' },
      data: { text: 'hello', points: [] },
      version: 3,
    };
    const next = mergeShapePatch(current, { x: 5, style: { stroke: '#ff0000' } });
    expect(next.x).toBe(5);
    expect(next.y).toBe(0);
    expect(next.style).toEqual({ stroke: '#ff0000', fill: '#ffffff' });
    expect(next.data).toEqual({ text: 'hello', points: [] });
    expect(next.version).toBe(4);
    // 原对象不被改动（纯函数）
    expect(current.x).toBe(0);
    expect(current.version).toBe(3);
  });

  it('mergeShapePatch：data 里的数组整体替换（freedraw 点集语义）', () => {
    const current = {
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      rotation: 0,
      zIndex: 0,
      style: {},
      data: { points: [{ x: 1, y: 1 }] },
      version: 1,
    };
    const next = mergeShapePatch(current, {
      data: {
        points: [
          { x: 2, y: 2 },
          { x: 3, y: 3 },
        ],
      },
    });
    expect(next.data.points).toEqual([
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);
  });

  it('toWireOp：按 opType 展开 payload（create 带 shape / update 带 patch / reorder 带 zIndex）', () => {
    const base: Omit<OpRow, 'payload' | 'opType' | 'shapeId'> = {
      seq: 4,
      boardId: BOARD_ID,
      actorId: uid(3),
      clientOpId: uid(201),
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    const created = toWireOp({
      ...base,
      opType: 'create',
      shapeId: uid(101),
      payload: { shape: makeShape({ id: uid(101) }) },
    });
    expect(created.shape?.id).toBe(uid(101));
    expect(created.seq).toBe(4);
    expect(created.createdAt).toBe('2026-01-02T00:00:00.000Z');

    const updated = toWireOp({
      ...base,
      opType: 'update',
      shapeId: uid(101),
      payload: { patch: { x: 1 }, baseVersion: 1 },
    });
    expect(updated.patch).toEqual({ x: 1 });

    const reordered = toWireOp({
      ...base,
      opType: 'reorder',
      shapeId: uid(101),
      payload: { zIndex: 5 },
    });
    expect(reordered.zIndex).toBe(5);

    const deleted = toWireOp({ ...base, opType: 'delete', shapeId: uid(101), payload: {} });
    expect(deleted.opType).toBe('delete');
    expect(deleted.shape).toBeUndefined();
  });
});

describe('board.replay', () => {
  it('快照 + op 回放：create/update/delete/reorder 的 fold 结果正确', () => {
    const base = [makeShape({ id: uid(101), x: 1 }), makeShape({ id: uid(102), zIndex: 5 })];
    const ops = [
      {
        opType: 'create' as const,
        shapeId: uid(103),
        clientOpId: uid(201),
        seq: 3,
        shape: makeShape({ id: uid(103) }),
        createdAt: '2026-01-02T00:00:00.000Z',
      },
      {
        opType: 'update' as const,
        shapeId: uid(101),
        clientOpId: uid(202),
        seq: 4,
        patch: { x: 42 },
        createdAt: '2026-01-02T00:00:01.000Z',
      },
      { opType: 'reorder' as const, shapeId: uid(102), clientOpId: uid(203), seq: 5, zIndex: 9 },
      {
        opType: 'delete' as const,
        shapeId: uid(103),
        clientOpId: uid(204),
        seq: 6,
        createdAt: '2026-01-02T00:00:02.000Z',
      },
    ];
    const state = replayOps(base, ops);
    expect(state.get(uid(101))?.x).toBe(42);
    expect(state.get(uid(101))?.version).toBe(2);
    expect(state.get(uid(102))?.zIndex).toBe(9);
    expect(state.get(uid(103))?.deletedAt).toBe('2026-01-02T00:00:02.000Z');
  });

  it('未知 op 类型 / 指向不存在图形的 op 被安全忽略（向前兼容）', () => {
    const base = [makeShape({ id: uid(101) })];
    const state = replayOps(base, [
      { opType: 'update', shapeId: uid(999), clientOpId: uid(201), patch: { x: 1 } },
      // 伪造一个未来版本才有的 op 类型
      { opType: 'unknown' as never, shapeId: uid(101), clientOpId: uid(202) },
    ]);
    expect(state.size).toBe(1);
    expect(state.get(uid(101))?.x).toBe(10);
  });
});
