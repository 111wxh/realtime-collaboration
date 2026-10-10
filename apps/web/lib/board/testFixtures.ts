/**
 * 测试夹具：构造合法的线上图形（Shape）。
 * 只在测试里使用；uuid 形状保证与协议 schema 一致，方便 copy 到联调用例里。
 */
import type { Shape, ShapeData, ShapeStyle, ShapeType } from '@collab/shared';

let counter = 0;

/** 递增的合法 UUID（v4 形状，便于肉眼核对 corpus） */
export function testId(prefix = '0'): string {
  counter += 1;
  const hex = counter.toString(16).padStart(12, '0');
  return `${prefix.repeat(8).slice(0, 8)}-0000-4000-8000-${hex}`;
}

export const BOARD_ID = '11111111-1111-4111-8111-111111111111';

export interface MakeShapeInput {
  type: ShapeType;
  id?: string;
  boardId?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  zIndex?: number;
  style?: ShapeStyle;
  data?: ShapeData;
  version?: number;
  createdBy?: string | null;
  deletedAt?: string | null;
}

export function makeShape(input: MakeShapeInput): Shape {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: input.id ?? testId(),
    boardId: input.boardId ?? BOARD_ID,
    type: input.type,
    x: input.x ?? 0,
    y: input.y ?? 0,
    w: input.w ?? 100,
    h: input.h ?? 50,
    rotation: 0,
    zIndex: input.zIndex ?? 0,
    style: input.style ?? { stroke: '#16181d', strokeWidth: 2, opacity: 1 },
    data: input.data ?? {},
    version: input.version ?? 1,
    createdBy: input.createdBy ?? null,
    deletedAt: input.deletedAt ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/** 以 id 为键的图形表 */
export function shapeMap(...shapes: Shape[]): Record<string, Shape> {
  const map: Record<string, Shape> = {};
  for (const shape of shapes) map[shape.id] = shape;
  return map;
}
