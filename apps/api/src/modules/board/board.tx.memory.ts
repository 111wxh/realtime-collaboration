import type { Shape } from '@collab/shared';

import type { BoardRow, BoardTx, BoardTxRunner, OpRow, ShapeRow, SnapshotRow } from './board.types';

/**
 * BoardTx 的内存实现——**只服务于单测**（体量小，编译进 dist 也不碍事）。
 *
 * 它存在的意义是让一致性逻辑"可测且测得准"：
 *  - `run()` 用一条 Promise 队列把并发写串行化，模拟 Postgres 的行锁；
 *  - 每次 run 先克隆状态，成功才提交、抛错就丢弃，模拟事务回滚，
 *    于是"批量原子性""幂等不产生副作用"这类断言才真正有意义。
 *
 * 它不是产品路径的一部分：真实运行环境永远走 PrismaBoardTxRunner（Postgres 才是权威）。
 */

interface MemoryState {
  boards: Map<string, BoardRow>;
  shapes: Map<string, ShapeRow>;
  ops: OpRow[];
  snapshots: Map<string, SnapshotRow>;
}

function cloneState(state: MemoryState): MemoryState {
  return structuredClone(state);
}

function cloneShape(row: ShapeRow): ShapeRow {
  return { ...row, style: { ...row.style }, data: { ...row.data } };
}

class MemoryBoardTx implements BoardTx {
  constructor(private readonly state: MemoryState) {}

  private shapeKey(boardId: string, shapeId: string): string {
    return `${boardId}:${shapeId}`;
  }

  async lockBoard(boardId: string): Promise<BoardRow | null> {
    const board = this.state.boards.get(boardId);
    return board ? { ...board } : null;
  }

  async findBoard(boardId: string): Promise<BoardRow | null> {
    const board = this.state.boards.get(boardId);
    return board ? { ...board } : null;
  }

  async getShape(boardId: string, shapeId: string): Promise<ShapeRow | null> {
    const row = this.state.shapes.get(this.shapeKey(boardId, shapeId));
    return row ? cloneShape(row) : null;
  }

  async listAliveShapes(boardId: string): Promise<ShapeRow[]> {
    return [...this.state.shapes.values()]
      .filter((row) => row.boardId === boardId && !row.deletedAt)
      .sort((a, b) => {
        if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
        if (a.createdAt.getTime() !== b.createdAt.getTime()) {
          return a.createdAt.getTime() - b.createdAt.getTime();
        }
        return a.id < b.id ? -1 : 1;
      })
      .map((row) => cloneShape(row));
  }

  async insertShape(row: ShapeRow): Promise<void> {
    const key = this.shapeKey(row.boardId, row.id);
    if (this.state.shapes.has(key)) throw new Error('duplicate shape id');
    this.state.shapes.set(key, cloneShape(row));
  }

  async updateShape(row: ShapeRow): Promise<void> {
    const key = this.shapeKey(row.boardId, row.id);
    if (!this.state.shapes.has(key)) throw new Error('shape not found');
    this.state.shapes.set(key, cloneShape(row));
  }

  async insertOp(op: OpRow): Promise<void> {
    // 唯一约束（board_id, seq）与（board_id, client_op_id）都要模拟，否则幂等测试形同虚设
    if (this.state.ops.some((row) => row.boardId === op.boardId && row.seq === op.seq)) {
      throw new Error('unique violation: shape_ops(board_id, seq)');
    }
    if (
      this.state.ops.some((row) => row.boardId === op.boardId && row.clientOpId === op.clientOpId)
    ) {
      throw new Error('unique violation: shape_ops(board_id, client_op_id)');
    }
    this.state.ops.push({ ...op, payload: structuredClone(op.payload) });
  }

  async findOpByClientOpId(boardId: string, clientOpId: string): Promise<OpRow | null> {
    return (
      this.state.ops.find((row) => row.boardId === boardId && row.clientOpId === clientOpId) ?? null
    );
  }

  async findLatestOpForShape(boardId: string, shapeId: string): Promise<OpRow | null> {
    const rows = this.state.ops.filter((row) => row.boardId === boardId && row.shapeId === shapeId);
    if (rows.length === 0) return null;
    return rows.reduce((max, row) => (row.seq > max.seq ? row : max), rows[0]!);
  }

  async listOpsAfter(boardId: string, sinceSeq: number): Promise<OpRow[]> {
    return this.state.ops
      .filter((row) => row.boardId === boardId && row.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq)
      .map((row) => ({ ...row, payload: structuredClone(row.payload) }));
  }

  async getOldestRetainedOpSeq(boardId: string): Promise<number | null> {
    const rows = this.state.ops.filter((row) => row.boardId === boardId);
    if (rows.length === 0) return null;
    return rows.reduce((min, row) => Math.min(min, row.seq), Number.POSITIVE_INFINITY);
  }

  async setLastSeq(boardId: string, seq: number): Promise<void> {
    const board = this.state.boards.get(boardId);
    if (!board) throw new Error('board not found');
    board.lastSeq = seq;
  }

  async getSnapshot(boardId: string): Promise<SnapshotRow | null> {
    const snapshot = this.state.snapshots.get(boardId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async saveSnapshot(boardId: string, seq: number, shapes: Shape[]): Promise<void> {
    this.state.snapshots.set(boardId, {
      boardId,
      seq,
      createdAt: new Date(),
      shapes: structuredClone(shapes),
    });
  }
}

/** 测试用的事务执行器：串行 + 克隆回滚 */
export class InMemoryBoardTxRunner implements BoardTxRunner {
  private state: MemoryState = {
    boards: new Map(),
    shapes: new Map(),
    ops: [],
    snapshots: new Map(),
  };

  private tail: Promise<unknown> = Promise.resolve();

  /** 播种数据：board 行 */
  seedBoard(boardId: string, roomId = 'room-test', lastSeq = 0): void {
    this.state.boards.set(boardId, { id: boardId, roomId, lastSeq });
  }

  /** 播种数据：形状行（绕过 op log，仅用于构造前置状态） */
  seedShape(row: ShapeRow): void {
    this.state.shapes.set(`${row.boardId}:${row.id}`, cloneShape(row));
  }

  /** 直接读内部状态（断言用） */
  inspect(): {
    boards: Map<string, BoardRow>;
    shapes: ShapeRow[];
    ops: OpRow[];
    snapshots: Map<string, SnapshotRow>;
  } {
    return {
      boards: this.state.boards,
      shapes: [...this.state.shapes.values()].map(cloneShape),
      ops: this.state.ops.map((row) => ({ ...row })),
      snapshots: this.state.snapshots,
    };
  }

  /** 换一个"时间"：把已有快照的 createdAt 往前挪，触发 60s 快照规则 */
  ageSnapshots(ms: number): void {
    for (const snapshot of this.state.snapshots.values()) {
      snapshot.createdAt = new Date(snapshot.createdAt.getTime() - ms);
    }
  }

  async run<T>(fn: (tx: BoardTx) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const draft = cloneState(this.state);
    try {
      const result = await fn(new MemoryBoardTx(draft));
      this.state = draft; // 提交
      return result;
    } finally {
      release();
    }
  }
}
