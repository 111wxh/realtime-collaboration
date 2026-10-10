import {
  ShapeOpSchema,
  ShapeSchema,
  ShapePatchSchema,
  type Shape,
  type ShapeOp,
  type ShapePatch,
} from '@collab/shared';

import type { OpRow, ShapeRow } from './board.types';

/**
 * DB 行 ↔ 协议 wire 类型的唯一转换点。
 *
 * 两处容易踩的坑都在这里收口：
 *  - BigInt：seq/version/last_seq 在 Postgres 是 bigint，Prisma 给的是 JS BigInt，
 *    直接 JSON.stringify 会抛错 → 统一 Number()；
 *  - Date：wire 协议里时间一律 ISO 字符串。
 */

export function toWireShape(row: ShapeRow): Shape {
  return ShapeSchema.parse({
    id: row.id,
    boardId: row.boardId,
    type: row.type,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    rotation: row.rotation,
    zIndex: row.zIndex,
    style: row.style ?? {},
    data: row.data ?? {},
    version: row.version,
    createdBy: row.createdBy,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** op 行 → wire ShapeOp（payload 里的 shape/patch/zIndex 按其 opType 展开） */
export function toWireOp(row: OpRow): ShapeOp {
  const payload = row.payload ?? {};
  const op: Record<string, unknown> = {
    opType: row.opType,
    shapeId: row.shapeId ?? '',
    clientOpId: row.clientOpId,
    seq: row.seq,
    createdAt: row.createdAt.toISOString(),
  };
  if (payload.shape) op.shape = payload.shape;
  if (payload.patch) op.patch = payload.patch;
  if (payload.zIndex !== undefined) op.zIndex = payload.zIndex;
  return ShapeOpSchema.parse(op);
}

/** 从 wire Shape 生成投影行：version 强制为 1，createdBy 取服务端认定的 actor */
export function shapeRowFromWire(shape: Shape, actorId: string | null, now = new Date()): ShapeRow {
  return {
    id: shape.id,
    boardId: shape.boardId,
    type: shape.type,
    x: shape.x,
    y: shape.y,
    w: shape.w,
    h: shape.h,
    rotation: shape.rotation,
    zIndex: shape.zIndex,
    style: shape.style as Record<string, unknown>,
    data: shape.data as Record<string, unknown>,
    version: 1,
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

/** patch 能改的字段集合：wire Shape 与 ShapeRow 都满足它，于是 merge 逻辑只需要写一份 */
export interface PatchableShape {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  zIndex: number;
  style: object;
  data: object;
  version: number;
}

/**
 * 应用 ShapePatch：标量直接覆盖，style/data 做**浅合并**（例如只改 stroke 时不丢 fill），
 * version 递增。协议里写的是"服务端 merge 后 version + 1"，这就是那份 merge 语义。
 */
export function mergeShapePatch<T extends PatchableShape>(current: T, patch: ShapePatch): T {
  const next: T = { ...current };
  if (patch.x !== undefined) next.x = patch.x;
  if (patch.y !== undefined) next.y = patch.y;
  if (patch.w !== undefined) next.w = patch.w;
  if (patch.h !== undefined) next.h = patch.h;
  if (patch.rotation !== undefined) next.rotation = patch.rotation;
  if (patch.zIndex !== undefined) next.zIndex = patch.zIndex;
  if (patch.style !== undefined) next.style = { ...current.style, ...patch.style };
  if (patch.data !== undefined) next.data = { ...current.data, ...patch.data };
  next.version = current.version + 1;
  return next;
}

/** 校验 patch 是否是合法 ShapePatch（batch 子 op 与 update 共用） */
export function parsePatch(input: unknown): ShapePatch {
  return ShapePatchSchema.parse(input);
}
