import {
  ERROR_CODES,
  type ErrorCode,
  type Shape,
  type ShapeOp,
  type ShapePatch,
} from '@collab/shared';

import { appError } from '../../common/errors';
import { toWireShape, mergeShapePatch, toWireOp } from './board.mapper';
import { aliveShapesOf, replayOps } from './board.replay';
import { SeqAllocator, type BoardTx, type OpRow, type ShapeRow } from './board.types';

/**
 * Board 写引擎——本项目一致性保证的全部落点（计划书 §7.1 / §7.5 / §5.4）。
 *
 * 每个写操作的固定套路：
 *   1) 幂等预检（clientOpId 已提交过 → 原样返回，无副作用）；
 *   2) 事务内 `lockBoard` 拿到行锁与 last_seq（seq 分配的唯一来源，绝不用 Redis INCR）；
 *   3) 锁内复查幂等（并发同 clientOpId 的两个请求，先到的已提交）；
 *   4) 校验（版本/存在性）→ 更新 shapes 投影 → 追加 shape_ops → 更新 boards.last_seq；
 *   5) 到阈值就顺手写快照（同一事务，快照与 seq 严格对齐）。
 *
 * 引擎只依赖 BoardTx 端口，因此可以脱离 Postgres 被单测直接驱动（见 board.tx.memory.ts）。
 */

export interface EngineOptions {
  /** 快照阈值：op 数（默认 200，§5.4） */
  snapshotEveryOps: number;
  /** 快照阈值：时间（默认 60s，§5.4） */
  snapshotEveryMs: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  snapshotEveryOps: 200,
  snapshotEveryMs: 60_000,
};

/** 一次写操作的结果：applied 已提交；duplicate 幂等命中；rejected 被拒（无副作用） */
export type WriteOutcome =
  | {
      status: 'applied';
      seq: number;
      op: OpRow;
      serverShape: ShapeRow | null;
      snapshotSeq?: number;
    }
  | {
      status: 'duplicate';
      /** 原 op 的 seq；拿不到（如按 shapeId 命中）时为 0，ack 里省略 */
      seq: number;
      op: OpRow | null;
      serverShape: ShapeRow | null;
      /** 命中原因：便于日志与排查 */
      reason: 'client_op_id' | 'shape_exists' | 'already_deleted';
    }
  | {
      status: 'rejected';
      code: ErrorCode;
      message: string;
      serverShape: ShapeRow | null;
    };

export interface CreateShapeInput {
  boardId: string;
  actorId: string | null;
  shape: Shape;
  clientOpId: string;
}

export interface UpdateShapeInput {
  boardId: string;
  actorId: string | null;
  shapeId: string;
  patch: ShapePatch;
  /** 缺省表示不做乐观并发校验（batch 子 op 没有这个字段，见交付报告） */
  baseVersion?: number;
  clientOpId: string;
  /**
   * op log 里记成 update 还是 reorder。
   * reorder 在协议里是**顶层 zIndex**（ShapeOpSchema），不是 patch——
   * 客户端回放 reorder 时读的是 op.zIndex，记成 patch 会让回放静默失效。
   */
  opKind?: 'update' | 'reorder';
}

export interface DeleteShapeInput {
  boardId: string;
  actorId: string | null;
  shapeId: string;
  clientOpId: string;
}

export interface SyncResult {
  kind: 'ops' | 'state';
  /** kind=ops：起始 seq（= sinceSeq + 1） */
  fromSeq?: number;
  ops?: ShapeOp[];
  /** kind=state：全量活图形 */
  shapes?: Shape[];
  /** 两种结果都带：board 当前的最新 seq */
  latestSeq: number;
}

export class BoardWriteEngine {
  constructor(private readonly options: EngineOptions = DEFAULT_ENGINE_OPTIONS) {}

  // -------------------------------------------------------------------------
  // 写操作
  // -------------------------------------------------------------------------

  async createShape(tx: BoardTx, input: CreateShapeInput): Promise<WriteOutcome> {
    const dupOp = await tx.findOpByClientOpId(input.boardId, input.clientOpId);
    if (dupOp) return this.duplicateOutcome(tx, dupOp, input.shape.id, 'client_op_id');

    const board = await tx.lockBoard(input.boardId);
    if (!board) return this.notFoundBoard();

    const dupInLock = await tx.findOpByClientOpId(input.boardId, input.clientOpId);
    if (dupInLock) return this.duplicateOutcome(tx, dupInLock, input.shape.id, 'client_op_id');

    const alloc = new SeqAllocator(board.lastSeq);
    const outcome = await this.writeCreate(tx, input, alloc);
    return this.finalize(tx, input.boardId, alloc, outcome);
  }

  async updateShape(tx: BoardTx, input: UpdateShapeInput): Promise<WriteOutcome> {
    const dupOp = await tx.findOpByClientOpId(input.boardId, input.clientOpId);
    if (dupOp) return this.duplicateOutcome(tx, dupOp, input.shapeId, 'client_op_id');

    const board = await tx.lockBoard(input.boardId);
    if (!board) return this.notFoundBoard();

    const dupInLock = await tx.findOpByClientOpId(input.boardId, input.clientOpId);
    if (dupInLock) return this.duplicateOutcome(tx, dupInLock, input.shapeId, 'client_op_id');

    const alloc = new SeqAllocator(board.lastSeq);
    const outcome = await this.writeUpdate(tx, input, alloc);
    return this.finalize(tx, input.boardId, alloc, outcome);
  }

  async deleteShape(tx: BoardTx, input: DeleteShapeInput): Promise<WriteOutcome> {
    const dupOp = await tx.findOpByClientOpId(input.boardId, input.clientOpId);
    if (dupOp) return this.duplicateOutcome(tx, dupOp, input.shapeId, 'client_op_id');

    const board = await tx.lockBoard(input.boardId);
    if (!board) return this.notFoundBoard();

    const dupInLock = await tx.findOpByClientOpId(input.boardId, input.clientOpId);
    if (dupInLock) return this.duplicateOutcome(tx, dupInLock, input.shapeId, 'client_op_id');

    const alloc = new SeqAllocator(board.lastSeq);
    const outcome = await this.writeDelete(tx, input, alloc);
    return this.finalize(tx, input.boardId, alloc, outcome);
  }

  /**
   * 批量写（多选移动 / 撤销重做）：
   *  - 整批一个事务、一次行锁、seq 连续递增；
   *  - 原子语义：任何一条被拒 → 整批回滚（抛 AppError，由网关翻成 shape:rejected）；
   *  - 重放整批时，已提交的子 op 按 clientOpId 命中幂等，不会重复应用。
   */
  async applyBatch(
    tx: BoardTx,
    input: { boardId: string; actorId: string | null; ops: ShapeOp[] },
  ): Promise<WriteOutcome[]> {
    const board = await tx.lockBoard(input.boardId);
    if (!board) throw appError(ERROR_CODES.NOT_FOUND, '画布不存在');

    const alloc = new SeqAllocator(board.lastSeq);
    const outcomes: WriteOutcome[] = [];
    for (const op of input.ops) {
      const outcome = await this.writeBatchOp(tx, input, op, alloc);
      if (outcome.status === 'rejected') {
        // 原子批次：一条失败整批不做，事务由调用方（runner）回滚
        throw appError(outcome.code, outcome.message);
      }
      outcomes.push(outcome);
    }
    await this.commitSeq(tx, input.boardId, alloc);
    return outcomes;
  }

  // -------------------------------------------------------------------------
  // 读 / 补齐
  // -------------------------------------------------------------------------

  /**
   * 断线补齐（§6.6 / §7.2）：
   *  - sinceSeq 已是最新 → 空 ops（客户端已对齐）；
   *  - sinceSeq 不早于"快照 seq"且 op log 保留窗口完整 → 增量 ops；
   *  - 否则 → 全量 state（恢复永远可行）。
   */
  async sync(tx: BoardTx, input: { boardId: string; sinceSeq: number }): Promise<SyncResult> {
    const board = await tx.findBoard(input.boardId);
    if (!board) throw appError(ERROR_CODES.NOT_FOUND, '画布不存在');
    const latestSeq = board.lastSeq;

    if (input.sinceSeq >= latestSeq) {
      return { kind: 'ops', fromSeq: latestSeq + 1, ops: [], latestSeq };
    }

    const snapshot = await tx.getSnapshot(input.boardId);
    const oldestRetained = await tx.getOldestRetainedOpSeq(input.boardId);
    // 可增量回放的下界：不能早于快照（快照之前的状态没保证），也不能早于保留窗口
    const floor = Math.max(
      snapshot?.seq ?? 0,
      oldestRetained === null ? Number.POSITIVE_INFINITY : oldestRetained - 1,
    );

    if (input.sinceSeq < floor) {
      return { kind: 'state', shapes: await this.fullState(tx, input.boardId), latestSeq };
    }

    const rows = await tx.listOpsAfter(input.boardId, input.sinceSeq);
    return {
      kind: 'ops',
      fromSeq: input.sinceSeq + 1,
      ops: rows.map((row) => this.opToWire(row)),
      latestSeq,
    };
  }

  /** 全量活图形（REST /api/boards/:id/state 与首次加入房间） */
  async fullState(tx: BoardTx, boardId: string): Promise<Shape[]> {
    const rows = await tx.listAliveShapes(boardId);
    return rows.map((row) => toWireShape(row));
  }

  /**
   * 冷启动重建：快照 + 之后的所有 op 顺序回放（§10 验收清单的最后一条）。
   * 结果应与 fullState（投影）完全一致——对账脚本/单测用这个等式兜底。
   */
  async rebuildFromLog(tx: BoardTx, boardId: string): Promise<{ seq: number; shapes: Shape[] }> {
    const board = await tx.findBoard(boardId);
    if (!board) throw appError(ERROR_CODES.NOT_FOUND, '画布不存在');
    const snapshot = await tx.getSnapshot(boardId);
    const base = snapshot?.shapes ?? [];
    const rows = await tx.listOpsAfter(boardId, snapshot?.seq ?? 0);
    const state = replayOps(
      base,
      rows.map((row) => this.opToWire(row)),
    );
    return { seq: board.lastSeq, shapes: aliveShapesOf(state) };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async writeBatchOp(
    tx: BoardTx,
    input: { boardId: string; actorId: string | null },
    op: ShapeOp,
    alloc: SeqAllocator,
  ): Promise<WriteOutcome> {
    // 子 op 级幂等：整批重发（客户端没收到 ack）时，已提交的子 op 必须命中而不是重复应用
    const existingOp = await tx.findOpByClientOpId(input.boardId, op.clientOpId);
    if (existingOp) {
      return this.duplicateOutcome(tx, existingOp, op.shapeId, 'client_op_id');
    }

    switch (op.opType) {
      case 'create': {
        if (!op.shape) {
          return this.rejected(
            ERROR_CODES.VALIDATION_FAILED,
            'batch 中的 create 必须带 shape',
            null,
          );
        }
        return this.writeCreate(
          tx,
          {
            boardId: input.boardId,
            actorId: input.actorId,
            shape: op.shape,
            clientOpId: op.clientOpId,
          },
          alloc,
        );
      }
      case 'update':
      case 'reorder': {
        const patch: ShapePatch | undefined =
          op.opType === 'reorder'
            ? op.zIndex === undefined
              ? undefined
              : { zIndex: op.zIndex }
            : op.patch;
        if (!patch) {
          return this.rejected(
            ERROR_CODES.VALIDATION_FAILED,
            op.opType === 'reorder'
              ? 'batch 中的 reorder 必须带 zIndex'
              : 'batch 中的 update 必须带 patch',
            null,
          );
        }
        return this.writeUpdate(
          tx,
          {
            boardId: input.boardId,
            actorId: input.actorId,
            shapeId: op.shapeId,
            patch,
            // batch 子 op 没有 baseVersion 字段：按无条件应用（版本仍 +1，保持单调）
            baseVersion: undefined,
            clientOpId: op.clientOpId,
            opKind: op.opType === 'reorder' ? 'reorder' : 'update',
          },
          alloc,
        );
      }
      case 'delete':
      case 'restore': {
        if (op.opType === 'restore') {
          return this.rejected(ERROR_CODES.VALIDATION_FAILED, 'restore 不在第一版范围内', null);
        }
        return this.writeDelete(
          tx,
          {
            boardId: input.boardId,
            actorId: input.actorId,
            shapeId: op.shapeId,
            clientOpId: op.clientOpId,
          },
          alloc,
        );
      }
      default:
        return this.rejected(ERROR_CODES.VALIDATION_FAILED, '未知 op 类型', null);
    }
  }

  private async writeCreate(
    tx: BoardTx,
    input: CreateShapeInput,
    alloc: SeqAllocator,
  ): Promise<WriteOutcome> {
    const existing = await tx.getShape(input.boardId, input.shape.id);
    // 图形 id 由客户端生成：换了 clientOpId 重试时按 id 命中，同样不重复创建（§5.4）
    if (existing && !existing.deletedAt) {
      const latest = await tx.findLatestOpForShape(input.boardId, input.shape.id);
      return {
        status: 'duplicate',
        seq: latest?.seq ?? 0,
        op: latest,
        serverShape: existing,
        reason: 'shape_exists',
      };
    }

    const now = new Date();
    const row: ShapeRow = {
      id: input.shape.id,
      boardId: input.boardId,
      type: input.shape.type,
      x: input.shape.x,
      y: input.shape.y,
      w: input.shape.w,
      h: input.shape.h,
      rotation: input.shape.rotation,
      zIndex: input.shape.zIndex,
      style: input.shape.style as Record<string, unknown>,
      data: input.shape.data as Record<string, unknown>,
      version: 1,
      createdBy: input.actorId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const seq = alloc.next();
    await tx.insertShape(row);
    const op = await this.appendOp(
      tx,
      {
        boardId: input.boardId,
        actorId: input.actorId,
        opType: 'create',
        shapeId: row.id,
        payload: { shape: toWireShape(row) },
        clientOpId: input.clientOpId,
        seq,
      },
      now,
    );
    return { status: 'applied', seq, op, serverShape: row };
  }

  private async writeUpdate(
    tx: BoardTx,
    input: UpdateShapeInput,
    alloc: SeqAllocator,
  ): Promise<WriteOutcome> {
    const row = await tx.getShape(input.boardId, input.shapeId);
    if (!row) {
      return this.rejected(ERROR_CODES.NOT_FOUND, '图形不存在', null);
    }
    if (row.deletedAt) {
      return this.rejected(ERROR_CODES.CONFLICT, '图形已删除', null);
    }
    if (input.baseVersion !== undefined && row.version !== input.baseVersion) {
      // 乐观并发：客户端基于旧版本改，服务端拒绝并把最新状态带回去让它重放（§7.5）
      return this.rejected(
        ERROR_CODES.VERSION_CONFLICT,
        `版本冲突：期望 baseVersion=${input.baseVersion}，服务端当前 ${row.version}`,
        row,
      );
    }

    const merged = mergeShapePatch(row, input.patch);
    // 同一个 now 同时用于投影的 updatedAt 与 op 的 createdAt：
    // 这样"投影 == 日志回放"是严格等式（回放用的是 op.createdAt）
    const now = new Date();
    const next: ShapeRow = { ...merged, updatedAt: now };
    const seq = alloc.next();
    await tx.updateShape(next);
    const opKind = input.opKind ?? 'update';
    const op = await this.appendOp(
      tx,
      {
        boardId: input.boardId,
        actorId: input.actorId,
        opType: opKind,
        shapeId: next.id,
        payload:
          opKind === 'reorder'
            ? { zIndex: input.patch.zIndex ?? next.zIndex }
            : {
                patch: input.patch,
                ...(input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {}),
              },
        clientOpId: input.clientOpId,
        seq,
      },
      now,
    );
    return { status: 'applied', seq, op, serverShape: next };
  }

  private async writeDelete(
    tx: BoardTx,
    input: DeleteShapeInput,
    alloc: SeqAllocator,
  ): Promise<WriteOutcome> {
    const row = await tx.getShape(input.boardId, input.shapeId);
    if (!row) {
      // 删除不存在的图形：视为已达成目标，不回滚客户端的乐观删除
      const latest = await tx.findLatestOpForShape(input.boardId, input.shapeId);
      return {
        status: 'duplicate',
        seq: latest?.seq ?? 0,
        op: latest,
        serverShape: null,
        reason: 'already_deleted',
      };
    }
    if (row.deletedAt) {
      const latest = await tx.findLatestOpForShape(input.boardId, input.shapeId);
      return {
        status: 'duplicate',
        seq: latest?.seq ?? 0,
        op: latest,
        serverShape: row,
        reason: 'already_deleted',
      };
    }

    const now = new Date();
    const next: ShapeRow = { ...row, deletedAt: now, updatedAt: now, version: row.version + 1 };
    const seq = alloc.next();
    await tx.updateShape(next);
    const op = await this.appendOp(
      tx,
      {
        boardId: input.boardId,
        actorId: input.actorId,
        opType: 'delete',
        shapeId: next.id,
        payload: {},
        clientOpId: input.clientOpId,
        seq,
      },
      now,
    );
    return { status: 'applied', seq, op, serverShape: null };
  }

  /** 提交序号 + 视阈值写快照；只有 applied 才需要 */
  private async finalize(
    tx: BoardTx,
    boardId: string,
    alloc: SeqAllocator,
    outcome: WriteOutcome,
  ): Promise<WriteOutcome> {
    if (outcome.status !== 'applied') return outcome;
    await this.commitSeq(tx, boardId, alloc);
    const snapshotSeq = await this.maybeSnapshot(tx, boardId, alloc.value);
    return snapshotSeq === undefined ? outcome : { ...outcome, snapshotSeq };
  }

  private async commitSeq(tx: BoardTx, boardId: string, alloc: SeqAllocator): Promise<void> {
    await tx.setLastSeq(boardId, alloc.value);
  }

  /** 每 200 op 或每 60s 写一次快照（§5.4）；快照与 seq 在同一事务里对齐 */
  private async maybeSnapshot(
    tx: BoardTx,
    boardId: string,
    seq: number,
  ): Promise<number | undefined> {
    const snapshot = await tx.getSnapshot(boardId);
    const opsSinceSnapshot = seq - (snapshot?.seq ?? 0);
    const aged =
      snapshot !== null &&
      Date.now() - snapshot.createdAt.getTime() >= this.options.snapshotEveryMs;
    if (opsSinceSnapshot < this.options.snapshotEveryOps && !(aged && opsSinceSnapshot > 0)) {
      return undefined;
    }
    const shapes = await this.fullState(tx, boardId);
    await tx.saveSnapshot(boardId, seq, shapes);
    return seq;
  }

  /** 追加 op：createdAt 由调用方传入（与投影的时间戳共用同一个 now，保证回放一致） */
  private async appendOp(tx: BoardTx, op: Omit<OpRow, 'createdAt'>, now: Date): Promise<OpRow> {
    const row: OpRow = { ...op, createdAt: now };
    await tx.insertOp(row);
    return row;
  }

  private opToWire(row: OpRow): ShapeOp {
    return toWireOp(row);
  }

  /** 幂等命中：返回原 op 的 seq + 当前投影，绝不产生副作用 */
  private async duplicateOutcome(
    tx: BoardTx,
    op: OpRow,
    shapeId: string,
    reason: 'client_op_id' | 'shape_exists' | 'already_deleted',
  ): Promise<WriteOutcome> {
    const serverShape = await tx.getShape(op.boardId, shapeId);
    return { status: 'duplicate', seq: op.seq, op, serverShape, reason };
  }

  private notFoundBoard(): WriteOutcome {
    return this.rejected(ERROR_CODES.NOT_FOUND, '画布不存在', null);
  }

  private rejected(code: ErrorCode, message: string, serverShape: ShapeRow | null): WriteOutcome {
    return { status: 'rejected', code, message, serverShape };
  }
}
