import type { Shape, ShapeOp } from '@collab/shared';

import { mergeShapePatch } from './board.mapper';

/**
 * op log 回放：把「快照 + ops」折成当前状态。
 *
 * 这是"操作日志即真相"（计划书 §4.3）的直接体现：
 *  - `shapes` 表只是同一份 fold 的物化投影；
 *  - 冷启动 / 对账 / 单测都复用这个函数，保证"重放 == 投影"是可验证的等式，
 *    而不是两套各自演化的实现。
 */
/**
 * op log 回放：把「快照 + ops」折成当前状态。
 *
 * 这是"操作日志即真相"（计划书 §4.3）的直接体现：
 *  - `shapes` 表只是同一份 fold 的物化投影；
 *  - 冷启动 / 对账 / 单测都复用这个函数，保证"重放 == 投影"是可验证的等式，
 *    而不是两套各自演化的实现。
 *
 * 因此每个分支都必须与引擎写投影时**逐字段一致**：投影的 updatedAt 取的是
 * 该次写的 `now`，而 op 的 createdAt 就是同一个 `now`（引擎里共用一个 Date），
 * 所以回放统一写成 `updatedAt = op.createdAt`。不动 updatedAt 的分支会让
 * "重放 == 投影"在毫秒级上永远差一点。
 */
export function applyOpToState(state: Map<string, Shape>, op: ShapeOp): void {
  const stamp = op.createdAt;
  switch (op.opType) {
    case 'create': {
      if (op.shape) state.set(op.shape.id, op.shape);
      return;
    }
    case 'update': {
      const current = state.get(op.shapeId);
      if (!current || !op.patch) return;
      const merged = mergeShapePatch(current, op.patch);
      state.set(op.shapeId, { ...merged, updatedAt: stamp ?? current.updatedAt });
      return;
    }
    case 'reorder': {
      const current = state.get(op.shapeId);
      if (!current || op.zIndex === undefined) return;
      const merged = mergeShapePatch(current, { zIndex: op.zIndex });
      state.set(op.shapeId, { ...merged, updatedAt: stamp ?? current.updatedAt });
      return;
    }
    case 'delete': {
      const current = state.get(op.shapeId);
      if (!current) return;
      const deletedAt = stamp ?? new Date().toISOString();
      // 投影里软删与 updatedAt 用的是同一个时间戳（引擎的 now）
      state.set(op.shapeId, { ...current, deletedAt, updatedAt: deletedAt });
      return;
    }
    case 'restore': {
      const current = state.get(op.shapeId);
      if (!current) return;
      state.set(op.shapeId, {
        ...current,
        deletedAt: null,
        updatedAt: stamp ?? current.updatedAt,
      });
      return;
    }
    default: {
      // 未知 op 类型：忽略而不是崩（向前兼容新版本客户端写入的 op）
      return;
    }
  }
}

/** 顺序回放一串 op（必须按 seq 升序） */
export function replayOps(base: Iterable<Shape>, ops: ShapeOp[]): Map<string, Shape> {
  const state = new Map<string, Shape>();
  for (const shape of base) state.set(shape.id, shape);
  for (const op of ops) applyOpToState(state, op);
  return state;
}

/** 从状态里取活图形（未软删），按 zIndex/创建时间稳定排序 */
export function aliveShapesOf(state: Map<string, Shape>): Shape[] {
  return [...state.values()]
    .filter((shape) => !shape.deletedAt)
    .sort((a, b) => {
      if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
}
