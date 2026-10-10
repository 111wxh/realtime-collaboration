import type { Shape, ShapeOp } from '@collab/shared';

/**
 * Board 领域层的行类型与端口定义。
 *
 * 为什么要抽这层端口（而不是让一致性逻辑直接摸 Prisma）：
 *  1. 事务内的动作被收敛成一个小接口（锁定行、读写投影、追加 op、写快照），
 *     一致性逻辑本身因此可以脱离数据库单测——单测跑的是**同一份**逻辑，
 *     只是把端口换成内存实现，而不是另一套"仿写"的实现；
 *  2. Prisma 的行类型（null 语义、BigInt、Date）不泄漏到领域逻辑里，
 *     wire 类型的转换只发生在 mapper 一处。
 */

/** shapes 行（投影）。version/lastSeq 统一用 number：协议与 JS 都只支持安全整数 */
export interface ShapeRow {
  id: string;
  boardId: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  zIndex: number;
  style: Record<string, unknown>;
  data: Record<string, unknown>;
  version: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** shape_ops 行（append-only 日志） */
export interface OpRow {
  seq: number;
  boardId: string;
  actorId: string | null;
  opType: ShapeOp['opType'];
  shapeId: string | null;
  payload: Record<string, unknown>;
  clientOpId: string;
  createdAt: Date;
}

/** boards 行：last_seq 是权威序列的当前位置 */
export interface BoardRow {
  id: string;
  roomId: string;
  lastSeq: number;
}

export interface SnapshotRow {
  boardId: string;
  seq: number;
  createdAt: Date;
  /** 快照状态里保存的是 wire 形状，冷启动可直接回放 op log */
  shapes: Shape[];
}

/**
 * 一个写事务内可用的全部数据库动作。
 * 所有实现都必须保证：`lockBoard` 之后的读写处于"该 board 已被独占"的语义下
 * （Postgres 的 SELECT ... FOR UPDATE 提供这个保证）。
 */
export interface BoardTx {
  /** 锁定 board 行（悲观锁）并返回当前 last_seq */
  lockBoard(boardId: string): Promise<BoardRow | null>;
  findBoard(boardId: string): Promise<BoardRow | null>;

  getShape(boardId: string, shapeId: string): Promise<ShapeRow | null>;
  listAliveShapes(boardId: string): Promise<ShapeRow[]>;
  insertShape(row: ShapeRow): Promise<void>;
  updateShape(row: ShapeRow): Promise<void>;

  insertOp(op: OpRow): Promise<void>;
  findOpByClientOpId(boardId: string, clientOpId: string): Promise<OpRow | null>;
  findLatestOpForShape(boardId: string, shapeId: string): Promise<OpRow | null>;
  listOpsAfter(boardId: string, sinceSeq: number): Promise<OpRow[]>;
  /** 保留窗口内最早的 op seq；返回 null 表示窗口内没有任何 op（不可增量） */
  getOldestRetainedOpSeq(boardId: string): Promise<number | null>;

  setLastSeq(boardId: string, seq: number): Promise<void>;

  getSnapshot(boardId: string): Promise<SnapshotRow | null>;
  saveSnapshot(boardId: string, seq: number, shapes: Shape[]): Promise<void>;
}

/**
 * 事务执行器：把"一组端口动作"包成一个原子提交。
 * Prisma 实现用 $transaction；内存实现用互斥队列 + 状态克隆模拟回滚。
 */
export interface BoardTxRunner {
  run<T>(fn: (tx: BoardTx) => Promise<T>): Promise<T>;
}

/** Nest 注入令牌（实现见 PrismaBoardTxRunner） */
export const BOARD_TX_RUNNER = 'BOARD_TX_RUNNER';

/** 顺序分配器：一次事务内分配的 seq 只在这里推进，提交时才落库 */
export class SeqAllocator {
  private current: number;

  constructor(start: number) {
    this.current = start;
  }

  next(): number {
    this.current += 1;
    return this.current;
  }

  get value(): number {
    return this.current;
  }
}
