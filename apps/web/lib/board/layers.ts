/**
 * 层级调整（zIndex）：把"上移/下移/置顶/置底"算成一批 zIndex patch。
 *
 * 实现方式：对可见图形做一次 Z 序重排（0..n-1），只把 zIndex 变化的图形打成 patch。
 * 相比"交换相邻 zIndex"，重排在多选、同序号、负数序号下都不会出现歧义，
 * 结果也直观（一按就动一格）。patch 通过 shape:batch 一次提交。
 *
 * 纯函数：输入可见图形 + 选中集 + 方向。
 */
import type { Shape } from '@collab/shared';

import { Z_INDEX_STEP } from './defaults';

export type LayerDirection = 'up' | 'down' | 'front' | 'back';

export interface LayerPatch {
  shapeId: string;
  /** 目标 zIndex；返回时已按 Z_INDEX_STEP 展开 */
  zIndex: number;
}

export const LAYER_LABELS: Record<LayerDirection, string> = {
  up: '上移一层',
  down: '下移一层',
  front: '置于顶层',
  back: '置于底层',
};

/** 按 zIndex 升序排序（同 zIndex 用 id 兜底，保证结果稳定） */
function sortedByZ(shapes: Shape[]): Shape[] {
  return [...shapes].sort((a, b) =>
    a.zIndex === b.zIndex ? (a.id < b.id ? -1 : 1) : a.zIndex - b.zIndex,
  );
}

/** 计算重排后的 Z 序（底 → 顶） */
function reorder(order: Shape[], selected: Set<string>, direction: LayerDirection): Shape[] {
  const next = [...order];
  if (direction === 'front' || direction === 'back') {
    const moving = next.filter((s) => selected.has(s.id));
    const rest = next.filter((s) => !selected.has(s.id));
    return direction === 'front' ? [...rest, ...moving] : [...moving, ...rest];
  }
  if (direction === 'up') {
    // 从顶层往下扫：选中且上方非选中的，与上方交换 —— 同组图形保持相对顺序
    for (let i = next.length - 2; i >= 0; i -= 1) {
      const current = next[i]!;
      const above = next[i + 1]!;
      if (selected.has(current.id) && !selected.has(above.id)) {
        next[i] = above;
        next[i + 1] = current;
      }
    }
    return next;
  }
  for (let i = 1; i < next.length; i += 1) {
    const current = next[i]!;
    const below = next[i - 1]!;
    if (selected.has(current.id) && !selected.has(below.id)) {
      next[i] = below;
      next[i - 1] = current;
    }
  }
  return next;
}

/**
 * 计算层级调整的 patch：只返回 zIndex 真的变了的图形。
 */
export function computeLayerPatches(
  shapes: Shape[],
  selection: string[],
  direction: LayerDirection,
): LayerPatch[] {
  if (selection.length === 0) return [];
  const selected = new Set(selection);
  const order = sortedByZ(shapes);
  if (order.length < 2) return [];
  const moved = reorder(order, selected, direction);

  const current = new Map(order.map((s) => [s.id, s.zIndex]));
  const patches: LayerPatch[] = [];
  moved.forEach((shape, index) => {
    const zIndex = index * Z_INDEX_STEP;
    if (current.get(shape.id) !== zIndex) {
      patches.push({ shapeId: shape.id, zIndex });
    }
  });
  return patches;
}

/** 新图形的 zIndex：当前最大 zIndex + 1（空画布从 0 开始） */
export function nextZIndex(shapes: Record<string, Shape>): number {
  let max = -1;
  for (const s of Object.values(shapes)) {
    if (s.zIndex > max) max = s.zIndex;
  }
  return max + Z_INDEX_STEP;
}

/** 可见图形（软删除的不参与渲染与命中测试），按 zIndex 升序返回 */
export function visibleShapes(shapes: Record<string, Shape>): Shape[] {
  return sortedByZ(Object.values(shapes).filter((s) => !s.deletedAt));
}
