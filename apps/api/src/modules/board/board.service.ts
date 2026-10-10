import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Shape, ShapeOp, ShapePatch } from '@collab/shared';

import { conflict, notFound } from '../../common/errors';
import { BoardWriteEngine, type SyncResult, type WriteOutcome } from './board.engine';
import { BOARD_TX_RUNNER, type BoardTx, type BoardTxRunner } from './board.types';
import { RoomService } from '../room/room.service';

export interface BoardStateView {
  boardId: string;
  /** 当前已提交的最大 seq */
  seq: number;
  shapes: Shape[];
}

/**
 * 画布服务：把"授权 + 事务 + 引擎"串起来，是对外（REST / WS 网关）的唯一入口。
 *
 * 分工：
 *  - RoomService.assertBoardAccess：客户端声明的 boardId 一律回到 room_members 校验（§7.7）；
 *  - BoardTxRunner：一个写操作 = 一个 Postgres 事务（§7.1）；
 *  - BoardWriteEngine：事务内的全部一致性判断（幂等 / 版本 / seq / 快照）。
 */
@Injectable()
export class BoardService {
  private readonly engine = new BoardWriteEngine();
  private readonly logger = new Logger(BoardService.name);

  constructor(
    @Inject(BOARD_TX_RUNNER) private readonly runner: BoardTxRunner,
    private readonly roomService: RoomService,
  ) {}

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  /** 全量状态（REST /api/boards/:id/state、首次进入房间） */
  async getState(userId: string, boardId: string): Promise<BoardStateView> {
    await this.roomService.assertBoardAccess(userId, boardId);
    return this.runner.run(async (tx) => {
      const board = await tx.findBoard(boardId);
      if (!board) throw notFound('画布不存在');
      return { boardId, seq: board.lastSeq, shapes: await this.engine.fullState(tx, boardId) };
    });
  }

  /**
   * 断线补齐（§7.2）：能增量就增量，够不着就全量。
   * 授权同样在事务外先做（客户端声明的 boardId 不可信）。
   */
  async sync(userId: string, boardId: string, sinceSeq: number): Promise<SyncResult> {
    await this.roomService.assertBoardAccess(userId, boardId);
    return this.runner.run((tx) => this.engine.sync(tx, { boardId, sinceSeq }));
  }

  /** 冷启动重建：快照 + op log 回放（对账 / 恢复验证用） */
  async rebuildFromLog(userId: string, boardId: string): Promise<{ seq: number; shapes: Shape[] }> {
    await this.roomService.assertBoardAccess(userId, boardId);
    return this.runner.run((tx) => this.engine.rebuildFromLog(tx, boardId));
  }

  // -------------------------------------------------------------------------
  // 写（网关与 REST 共用；返回结构化结果，由调用方决定如何回执/广播）
  // -------------------------------------------------------------------------

  async createShape(
    userId: string,
    input: { boardId: string; shape: Shape; clientOpId: string },
  ): Promise<WriteOutcome> {
    await this.roomService.assertBoardAccess(userId, input.boardId);
    return this.executeWrite(
      { boardId: input.boardId, clientOpId: input.clientOpId, shapeId: input.shape.id },
      (tx) =>
        this.engine.createShape(tx, {
          boardId: input.boardId,
          actorId: userId,
          shape: input.shape,
          clientOpId: input.clientOpId,
        }),
    );
  }

  async updateShape(
    userId: string,
    input: {
      boardId: string;
      shapeId: string;
      patch: ShapePatch;
      baseVersion: number;
      clientOpId: string;
    },
  ): Promise<WriteOutcome> {
    await this.roomService.assertBoardAccess(userId, input.boardId);
    return this.executeWrite(
      { boardId: input.boardId, clientOpId: input.clientOpId, shapeId: input.shapeId },
      (tx) =>
        this.engine.updateShape(tx, {
          boardId: input.boardId,
          actorId: userId,
          shapeId: input.shapeId,
          patch: input.patch,
          baseVersion: input.baseVersion,
          clientOpId: input.clientOpId,
        }),
    );
  }

  async deleteShape(
    userId: string,
    input: { boardId: string; shapeId: string; clientOpId: string },
  ): Promise<WriteOutcome> {
    await this.roomService.assertBoardAccess(userId, input.boardId);
    return this.executeWrite(
      { boardId: input.boardId, clientOpId: input.clientOpId, shapeId: input.shapeId },
      (tx) =>
        this.engine.deleteShape(tx, {
          boardId: input.boardId,
          actorId: userId,
          shapeId: input.shapeId,
          clientOpId: input.clientOpId,
        }),
    );
  }

  /** 批量：整批一个事务；被拒时抛 AppError（网关翻成 shape:rejected） */
  async applyBatch(
    userId: string,
    input: { boardId: string; ops: ShapeOp[] },
  ): Promise<WriteOutcome[]> {
    await this.roomService.assertBoardAccess(userId, input.boardId);
    return this.runner.run((tx) =>
      this.engine.applyBatch(tx, { boardId: input.boardId, actorId: userId, ops: input.ops }),
    );
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 统一收口并发幂等竞态：两个请求带同一 clientOpId 同时进入时，
   * 后提交的一方会撞上 (board_id, client_op_id) 唯一约束（P2002）。
   * 这时事务已回滚，重读已提交的 op，按幂等命中返回——客户端拿到的 seq 与先到者一致。
   */
  private async executeWrite(
    keys: { boardId: string; clientOpId: string; shapeId: string },
    fn: (tx: BoardTx) => Promise<WriteOutcome>,
  ): Promise<WriteOutcome> {
    try {
      return await this.runner.run(fn);
    } catch (error) {
      if (this.isClientOpIdConflict(error)) {
        this.logger.warn({ ...keys }, '并发重复 clientOpId，按幂等命中返回');
        const existing = await this.runner.run((tx) =>
          tx.findOpByClientOpId(keys.boardId, keys.clientOpId),
        );
        const serverShape = await this.runner.run((tx) => tx.getShape(keys.boardId, keys.shapeId));
        if (!existing) throw error;
        return {
          status: 'duplicate',
          seq: existing.seq,
          op: existing,
          serverShape,
          reason: 'client_op_id',
        };
      }
      if (this.isUniqueViolation(error)) {
        // shapes.id 是全局主键（§5.2）：客户端跨画布重用了同一个图形 id 时会撞它。
        // 这属于客户端 bug，翻成 CONFLICT 让前端重新生成 id，而不是抛 500。
        this.logger.warn({ ...keys }, '唯一约束冲突，图形 id 已被占用');
        throw conflict('图形 ID 已被占用，请重新生成后再提交');
      }
      throw error;
    }
  }

  private isClientOpIdConflict(error: unknown): boolean {
    const fields = this.uniqueViolationFields(error);
    return fields?.some((f) => f.includes('client_op_id')) ?? false;
  }

  private isUniqueViolation(error: unknown): boolean {
    return this.uniqueViolationFields(error) !== null;
  }

  private uniqueViolationFields(error: unknown): string[] | null {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return null;
    }
    const target = error.meta?.target;
    return Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  }
}
