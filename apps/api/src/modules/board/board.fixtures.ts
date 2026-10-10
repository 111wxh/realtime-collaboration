import type { Shape, ShapeOp } from '@collab/shared';

import { BoardWriteEngine, DEFAULT_ENGINE_OPTIONS, type EngineOptions } from './board.engine';
import { InMemoryBoardTxRunner } from './board.tx.memory';
import type { ShapeRow } from './board.types';

/**
 * 单测共用夹具：确定性 UUID、wire 图形构造器、内存事务执行器。
 * 名字以 .fixtures.ts 结尾，`tsconfig.build.json` 已把它排除出构建产物。
 */

/** 生成合法 UUID（版本位 4 / 变体位 8，能过 zod 的 .uuid()） */
export function uid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const BOARD_ID = uid(1);
export const ROOM_ID = uid(2);
export const USER_A = uid(3);
export const USER_B = uid(4);

export function makeShape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: overrides.id ?? uid(100),
    boardId: overrides.boardId ?? BOARD_ID,
    type: overrides.type ?? 'rect',
    x: overrides.x ?? 10,
    y: overrides.y ?? 20,
    w: overrides.w ?? 100,
    h: overrides.h ?? 50,
    rotation: overrides.rotation ?? 0,
    zIndex: overrides.zIndex ?? 0,
    style: overrides.style ?? { stroke: '#000000' },
    data: overrides.data ?? {},
    version: overrides.version ?? 1,
    createdBy: overrides.createdBy ?? null,
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt ?? new Date(0).toISOString(),
    updatedAt: overrides.updatedAt ?? new Date(0).toISOString(),
  };
}

export function makeSeedShapeRow(overrides: Partial<ShapeRow> = {}): ShapeRow {
  return {
    id: overrides.id ?? uid(100),
    boardId: overrides.boardId ?? BOARD_ID,
    type: overrides.type ?? 'rect',
    x: overrides.x ?? 10,
    y: overrides.y ?? 20,
    w: overrides.w ?? 100,
    h: overrides.h ?? 50,
    rotation: overrides.rotation ?? 0,
    zIndex: overrides.zIndex ?? 0,
    style: overrides.style ?? {},
    data: overrides.data ?? {},
    version: overrides.version ?? 1,
    createdBy: overrides.createdBy ?? null,
    createdAt: overrides.createdAt ?? new Date(0),
    updatedAt: overrides.updatedAt ?? new Date(0),
    deletedAt: overrides.deletedAt ?? null,
  };
}

export function makeOp(
  overrides: Partial<ShapeOp> & { clientOpId: string; shapeId: string },
): ShapeOp {
  return {
    opType: overrides.opType ?? 'update',
    shapeId: overrides.shapeId,
    clientOpId: overrides.clientOpId,
    ...(overrides.shape ? { shape: overrides.shape } : {}),
    ...(overrides.patch ? { patch: overrides.patch } : {}),
    ...(overrides.zIndex !== undefined ? { zIndex: overrides.zIndex } : {}),
  };
}

export interface TestHarness {
  runner: InMemoryBoardTxRunner;
  engine: BoardWriteEngine;
}

export function setupHarness(options: Partial<EngineOptions> = {}): TestHarness {
  const runner = new InMemoryBoardTxRunner();
  runner.seedBoard(BOARD_ID, ROOM_ID);
  const engine = new BoardWriteEngine({ ...DEFAULT_ENGINE_OPTIONS, ...options });
  return { runner, engine };
}
