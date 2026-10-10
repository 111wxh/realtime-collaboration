import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

import { APP_CONFIG, type AppConfig } from '../../common/config';
import { PrismaService } from '../../prisma/prisma.service';
import type { BoardRow, BoardTx, BoardTxRunner, OpRow, ShapeRow, SnapshotRow } from './board.types';

/** Prisma 事务客户端的最小形状（避免把 $transaction 的泛型细节泄进端口实现） */
type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

function toNumber(value: bigint | number): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

function toJsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * BoardTx 的 Postgres 实现。这里只做三件事：翻译读写、拿行锁、保持类型边界干净。
 * 事务边界由 PrismaBoardTxRunner 提供（$transaction）。
 */
export class PrismaBoardTx implements BoardTx {
  constructor(
    private readonly tx: Tx,
    /** oplog 保留窗口（天）：判断增量补齐是否还够得着（§7.2） */
    private readonly retentionDays: number,
  ) {}

  async lockBoard(boardId: string): Promise<BoardRow | null> {
    // 行锁是 seq 分配的唯一闸门：同一 board 的并发写在这里排队，
    // 拿到 last_seq 后的 +1 与后续写入天然串行（§5.4 / §7.1）
    const rows = await this.tx.$queryRaw<Array<{ id: string; room_id: string; last_seq: bigint }>>`
      SELECT id, room_id, last_seq FROM boards WHERE id = ${boardId}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, roomId: row.room_id, lastSeq: toNumber(row.last_seq) };
  }

  async findBoard(boardId: string): Promise<BoardRow | null> {
    const row = await this.tx.board.findUnique({
      where: { id: boardId },
      select: { id: true, roomId: true, lastSeq: true },
    });
    return row ? { id: row.id, roomId: row.roomId, lastSeq: toNumber(row.lastSeq) } : null;
  }

  async getShape(boardId: string, shapeId: string): Promise<ShapeRow | null> {
    const row = await this.tx.shape.findFirst({ where: { id: shapeId, boardId } });
    return row ? this.toShapeRow(row) : null;
  }

  async listAliveShapes(boardId: string): Promise<ShapeRow[]> {
    const rows = await this.tx.shape.findMany({
      where: { boardId, deletedAt: null },
      orderBy: [{ zIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.toShapeRow(row));
  }

  async insertShape(row: ShapeRow): Promise<void> {
    await this.tx.shape.create({ data: this.shapeData(row) });
  }

  async updateShape(row: ShapeRow): Promise<void> {
    await this.tx.shape.update({ where: { id: row.id }, data: this.shapeData(row) });
  }

  async insertOp(op: OpRow): Promise<void> {
    await this.tx.shapeOp.create({
      data: {
        boardId: op.boardId,
        seq: BigInt(op.seq),
        actorId: op.actorId,
        opType: op.opType,
        shapeId: op.shapeId,
        payload: op.payload as Prisma.InputJsonValue,
        clientOpId: op.clientOpId,
        createdAt: op.createdAt,
      },
    });
  }

  async findOpByClientOpId(boardId: string, clientOpId: string): Promise<OpRow | null> {
    const row = await this.tx.shapeOp.findFirst({ where: { boardId, clientOpId } });
    return row ? this.toOpRow(row) : null;
  }

  async findLatestOpForShape(boardId: string, shapeId: string): Promise<OpRow | null> {
    const row = await this.tx.shapeOp.findFirst({
      where: { boardId, shapeId },
      orderBy: { seq: 'desc' },
    });
    return row ? this.toOpRow(row) : null;
  }

  async listOpsAfter(boardId: string, sinceSeq: number): Promise<OpRow[]> {
    const rows = await this.tx.shapeOp.findMany({
      where: { boardId, seq: { gt: BigInt(sinceSeq) } },
      orderBy: { seq: 'asc' },
    });
    return rows.map((row) => this.toOpRow(row));
  }

  async getOldestRetainedOpSeq(boardId: string): Promise<number | null> {
    // 保留窗口之外的 op 认为"可能已被清理"：补齐时不能依赖（§7.2）
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000);
    const row = await this.tx.shapeOp.findFirst({
      where: { boardId, createdAt: { gte: cutoff } },
      orderBy: { seq: 'asc' },
      select: { seq: true },
    });
    return row ? toNumber(row.seq) : null;
  }

  async setLastSeq(boardId: string, seq: number): Promise<void> {
    await this.tx.board.update({ where: { id: boardId }, data: { lastSeq: BigInt(seq) } });
  }

  async getSnapshot(boardId: string): Promise<SnapshotRow | null> {
    const row = await this.tx.boardSnapshot.findUnique({ where: { boardId } });
    if (!row) return null;
    const state = toJsonObject(row.state);
    const shapes = Array.isArray(state.shapes) ? (state.shapes as SnapshotRow['shapes']) : [];
    return { boardId: row.boardId, seq: toNumber(row.seq), createdAt: row.createdAt, shapes };
  }

  async saveSnapshot(boardId: string, seq: number, shapes: SnapshotRow['shapes']): Promise<void> {
    const state = { shapes } as unknown as Prisma.InputJsonValue;
    await this.tx.boardSnapshot.upsert({
      where: { boardId },
      create: { boardId, seq: BigInt(seq), state },
      update: { seq: BigInt(seq), state, createdAt: new Date() },
    });
  }

  private shapeData(row: ShapeRow): Prisma.ShapeUncheckedCreateInput {
    return {
      id: row.id,
      boardId: row.boardId,
      type: row.type,
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      rotation: row.rotation,
      zIndex: row.zIndex,
      style: row.style as Prisma.InputJsonValue,
      data: row.data as Prisma.InputJsonValue,
      version: BigInt(row.version),
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }

  private toShapeRow(row: {
    id: string;
    boardId: string;
    type: string;
    x: number;
    y: number;
    w: number;
    h: number;
    rotation: number;
    zIndex: number;
    style: Prisma.JsonValue;
    data: Prisma.JsonValue;
    version: bigint;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }): ShapeRow {
    return {
      id: row.id,
      boardId: row.boardId,
      type: row.type,
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      rotation: row.rotation,
      zIndex: row.zIndex,
      style: toJsonObject(row.style),
      data: toJsonObject(row.data),
      version: toNumber(row.version),
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }

  private toOpRow(row: {
    seq: bigint;
    boardId: string;
    actorId: string | null;
    opType: string;
    shapeId: string | null;
    payload: Prisma.JsonValue;
    clientOpId: string;
    createdAt: Date;
  }): OpRow {
    return {
      seq: toNumber(row.seq),
      boardId: row.boardId,
      actorId: row.actorId,
      opType: row.opType as OpRow['opType'],
      shapeId: row.shapeId,
      payload: toJsonObject(row.payload),
      clientOpId: row.clientOpId,
      createdAt: row.createdAt,
    };
  }
}

/**
 * 事务执行器：一次写操作 = 一个 Postgres 事务。
 * 隔离级别用默认的 ReadCommitted + 行锁（MySQL 里等价于"锁读"），
 * 因为串行化已经由 boards 行的 FOR UPDATE 提供，不需要更高的隔离级别带来的重试成本。
 */
@Injectable()
export class PrismaBoardTxRunner implements BoardTxRunner {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async run<T>(fn: (tx: BoardTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => fn(new PrismaBoardTx(tx as unknown as Tx, this.config.oplogRetentionDays)),
      { timeout: 15_000, maxWait: 10_000 },
    );
  }
}
