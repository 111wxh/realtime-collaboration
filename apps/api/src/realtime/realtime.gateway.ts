import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import {
  CLIENT_EVENTS,
  ERROR_CODES,
  SERVER_EVENTS,
  makeServerEnvelope,
  type ClientEnvelope,
  type ClientEventName,
  type ErrorCode,
  type ErrorPayload,
  type PresenceMember,
  type ServerEnvelope,
  type ServerEventName,
  type ServerPayload,
  type Shape,
  type ShapeOp,
  type ShapePatch,
} from '@collab/shared';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server } from 'socket.io';

import { AppError } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { CURSOR_RATE, WRITE_RATE } from '../common/token-bucket';
import { extractWsToken } from '../common/tokens';
import { RedisService } from '../redis/redis.service';
import { AuthService } from '../modules/auth/auth.service';
import { toWireOp, toWireShape } from '../modules/board/board.mapper';
import { BoardService } from '../modules/board/board.service';
import type { SyncResult, WriteOutcome } from '../modules/board/board.engine';
import { PresenceService } from '../modules/presence/presence.service';
import { RoomService } from '../modules/room/room.service';
import { parseIncoming, type AppSocket } from './ws-message';

/** 光标合并窗口：30–50ms 内同一连接只广播最后一个位置（§7.4） */
const CURSOR_THROTTLE_MS = 40;

/** Socket.IO 房间名（与业务 roomId 区分开，避免和 socket.id 之类的内部房间混淆） */
function roomChannel(roomId: string): string {
  return `room:${roomId}`;
}

/**
 * 从写操作的 payload 里取幂等键：单条 op 用 payload.clientOpId，
 * 批量（shape:batch）用第一个子 op 的——shape:rejected 需要它来和客户端 pending 关联。
 */
function extractClientOpId(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const record = payload as { clientOpId?: unknown; ops?: Array<{ clientOpId?: unknown }> };
  if (typeof record.clientOpId === 'string') return record.clientOpId;
  const first = record.ops?.[0]?.clientOpId;
  return typeof first === 'string' ? first : '';
}

/**
 * 实时网关。职责边界（计划书 §4.2 分层职责）：
 *  - 握手鉴权、订阅管理、消息校验、限流 —— 在网关；
 *  - 一致性规则、seq、事务 —— 在 BoardService/引擎；
 *  - 传输细节（ack、广播、房间）—— 在网关。
 *
 * 上行消息一律先过 `parseIncoming`（shared 的协议 schema），非法消息回 error 且不崩；
 * 图形写操作只有在 BoardService 事务**提交成功之后**才 ack 与广播。
 */
@WebSocketGateway({
  // 单消息上限（§7.7 消息体限制）：超限由 Socket.IO 直接断开
  maxHttpBufferSize: Number(process.env.WS_MAX_BUFFER ?? 1_048_576),
  cors: {
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim()),
    credentials: true,
  },
})
export class RealtimeGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy,
    OnApplicationShutdown
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);
  /**
   * adapter 自己的 pub/sub 连接：**不复用** RedisService 的主连接。
   * 复用的话，关闭顺序不确定（RedisService.quit 与 adapter.close 谁先谁后）
   * 会让 adapter 在已关闭的连接上发 UNSUBSCRIBE，产生 unhandled rejection。
   */
  private adapterClients: Array<{ quit(): Promise<unknown> }> = [];
  /** 光标节流：socketId → 待广播的最新位置 */
  private readonly cursorPending = new Map<
    string,
    { roomId: string; x: number; y: number; tool?: string; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly jwt: JwtService,
    private readonly authService: AuthService,
    private readonly roomService: RoomService,
    private readonly boardService: BoardService,
    private readonly presence: PresenceService,
    private readonly rateLimit: RateLimitService,
    private readonly redis: RedisService,
  ) {}

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  afterInit(server: Server): void {
    // 多实例广播：redis-adapter 让 server.to(room) 跨进程生效。
    // REDIS_URL 缺失时保持内存适配器，单实例语义（本地开发/测试可用）。
    const raw = this.redis.raw;
    if (this.redis.enabled && raw) {
      const pubClient = raw.duplicate();
      const subClient = raw.duplicate();
      this.adapterClients = [pubClient, subClient];
      server.adapter(createAdapter(pubClient, subClient));
      this.logger.log('Socket.IO 已接入 Redis Adapter（多实例广播）');
    } else {
      this.logger.warn('未配置 REDIS_URL：Socket.IO 使用内存适配器（仅单实例）');
    }

    // 握手鉴权：无 token / token 无效直接在连接建立前拒绝
    server.use((socket, next) => {
      void this.authenticate(socket as AppSocket)
        .then(() => next())
        .catch((error: unknown) => next(this.wsAuthError(error)));
    });
  }

  async onModuleDestroy(): Promise<void> {
    for (const pending of this.cursorPending.values()) clearTimeout(pending.timer);
    this.cursorPending.clear();
  }

  /**
   * adapter 的 Redis 连接留到 onApplicationShutdown 才断开。
   *
   * Nest 的关闭顺序是：onModuleDestroy → beforeApplicationShutdown → dispose()
   * （socketModule.close → io adapter close）→ onApplicationShutdown。
   * 也就是说 adapter 的 close() 会调用 pub/sub 的 unsubscribe；如果我们在
   * onModuleDestroy 就把连接 quit 掉，那一步会在已关闭的连接上发命令，
   * 抛出一串没人 catch 的 "Connection is closed"。放到最后一个钩子里最稳。
   */
  async onApplicationShutdown(): Promise<void> {
    for (const client of this.adapterClients) {
      await client.quit().catch(() => undefined);
    }
    this.adapterClients = [];
  }

  handleConnection(socket: AppSocket): void {
    const user = socket.data.user;
    socket.data.rooms = socket.data.rooms ?? new Set<string>();
    this.logger.debug({ socketId: socket.id, userId: user?.id }, 'WS 连接建立');
  }

  async handleDisconnect(socket: AppSocket): Promise<void> {
    const user = socket.data.user;
    // 光标定时器必须先清，否则断线后还会广播一次
    const pending = this.cursorPending.get(socket.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.cursorPending.delete(socket.id);
      this.presence.setCursor(pending.roomId, user?.id ?? '', null).catch(() => undefined);
    }
    for (const roomId of [...(socket.data.rooms ?? [])]) {
      await this.leaveRoom(socket, roomId).catch((error) =>
        this.logger.warn({ err: error, roomId }, '断线清理房间失败'),
      );
    }
    this.logger.debug({ socketId: socket.id, userId: user?.id }, 'WS 连接断开');
  }

  // -------------------------------------------------------------------------
  // 控制通道
  // -------------------------------------------------------------------------

  @SubscribeMessage(CLIENT_EVENTS.ROOM_JOIN)
  async onRoomJoin(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    await this.guard(socket, body, CLIENT_EVENTS.ROOM_JOIN, async (envelope) => {
      const user = this.requireUser(socket);
      const { roomId, sinceSeq } = envelope.payload as {
        roomId: string;
        sinceSeq?: number;
      };

      // 授权：房间成员表说了算（§7.7，不信任客户端声明的 roomId）
      await this.roomService.assertMembership(user.id, roomId);
      const boardId = await this.roomService.boardIdOfRoom(roomId);
      if (!boardId) throw new AppError(ERROR_CODES.NOT_FOUND, '房间没有画布', 404);

      await socket.join(roomChannel(roomId));
      socket.data.rooms.add(roomId);

      const profile = await this.authService.me(user.id);
      const self: PresenceMember = {
        userId: profile.id,
        displayName: profile.displayName,
        avatarColor: profile.avatarColor,
        cursor: null,
        onlineAt: new Date().toISOString(),
      };
      const { alreadyOnline } = await this.presence.join(roomId, {
        userId: profile.id,
        displayName: profile.displayName,
        avatarColor: profile.avatarColor,
      });

      const members = await this.presence.list(roomId);
      this.emit(socket, SERVER_EVENTS.ROOM_JOINED, {
        roomId,
        boardId,
        self,
        members: members.some((m) => m.userId === self.userId) ? members : [self, ...members],
      });

      // 只有"真的从离线变在线"才广播 joined：同一个人开第二个标签页不该再刷一条
      if (!alreadyOnline) {
        this.broadcastExcept(socket, roomId, SERVER_EVENTS.PRESENCE_JOINED, {
          userId: profile.id,
          displayName: profile.displayName,
          avatarColor: profile.avatarColor,
        });
      }
      this.broadcast(roomId, SERVER_EVENTS.PRESENCE_LIST, { roomId, members });

      await this.deliverBoard(socket, boardId, sinceSeq);
      void this.roomService.touchMember(roomId, user.id);
    });
  }

  @SubscribeMessage(CLIENT_EVENTS.ROOM_LEAVE)
  async onRoomLeave(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    await this.guard(socket, body, CLIENT_EVENTS.ROOM_LEAVE, async (envelope) => {
      const { roomId } = envelope.payload as { roomId: string };
      if (!socket.data.rooms.has(roomId)) return;
      await this.leaveRoom(socket, roomId);
      socket.leave(roomChannel(roomId));
      socket.data.rooms.delete(roomId);
    });
  }

  @SubscribeMessage(CLIENT_EVENTS.BOARD_SYNC)
  async onBoardSync(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    await this.guard(socket, body, CLIENT_EVENTS.BOARD_SYNC, async (envelope) => {
      const user = this.requireUser(socket);
      const { boardId, sinceSeq } = envelope.payload as { boardId: string; sinceSeq: number };
      const sync = await this.boardService.sync(user.id, boardId, sinceSeq);
      this.emitSync(socket, sync, boardId);
    });
  }

  /**
   * 应用层心跳：RTT 由 Socket.IO 的 ack 回执测量（客户端 emit 时传回调）。
   * 协议里没有独立的 pong 事件，返回值只作为 ack 载荷，不写进 server 事件注册表。
   */
  @SubscribeMessage(CLIENT_EVENTS.PING)
  onPing(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: unknown,
  ): { v: 1; ts: number } | undefined {
    const parsed = parseIncoming(body, CLIENT_EVENTS.PING);
    if (!parsed.ok) {
      this.emitError(socket, parsed.error);
      return undefined;
    }
    return { v: 1, ts: Date.now() };
  }

  // -------------------------------------------------------------------------
  // 操作通道（写）
  // -------------------------------------------------------------------------

  @SubscribeMessage(CLIENT_EVENTS.SHAPE_CREATE)
  async onShapeCreate(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    await this.guardWrite(socket, body, CLIENT_EVENTS.SHAPE_CREATE, async (envelope) => {
      const user = this.requireUser(socket);
      if (!(await this.consumeWrite(socket, user.id))) return;
      const payload = envelope.payload as { boardId: string; shape: Shape; clientOpId: string };
      const roomId = await this.boardRoomId(user.id, payload.boardId);

      const outcome = await this.boardService.createShape(user.id, {
        boardId: payload.boardId,
        shape: payload.shape,
        clientOpId: payload.clientOpId,
      });
      this.settleWriteOutcome(
        socket,
        roomId,
        envelope,
        payload.clientOpId,
        outcome,
        SERVER_EVENTS.SHAPE_CREATED,
      );
    });
  }

  @SubscribeMessage(CLIENT_EVENTS.SHAPE_UPDATE)
  async onShapeUpdate(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    await this.guardWrite(socket, body, CLIENT_EVENTS.SHAPE_UPDATE, async (envelope) => {
      const user = this.requireUser(socket);
      if (!(await this.consumeWrite(socket, user.id))) return;
      const payload = envelope.payload as {
        boardId: string;
        shapeId: string;
        patch: ShapePatch;
        baseVersion: number;
        clientOpId: string;
      };
      const roomId = await this.boardRoomId(user.id, payload.boardId);

      const outcome = await this.boardService.updateShape(user.id, {
        boardId: payload.boardId,
        shapeId: payload.shapeId,
        patch: payload.patch,
        baseVersion: payload.baseVersion,
        clientOpId: payload.clientOpId,
      });
      this.settleWriteOutcome(
        socket,
        roomId,
        envelope,
        payload.clientOpId,
        outcome,
        SERVER_EVENTS.SHAPE_UPDATED,
      );
    });
  }

  @SubscribeMessage(CLIENT_EVENTS.SHAPE_DELETE)
  async onShapeDelete(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    await this.guardWrite(socket, body, CLIENT_EVENTS.SHAPE_DELETE, async (envelope) => {
      const user = this.requireUser(socket);
      if (!(await this.consumeWrite(socket, user.id))) return;
      const payload = envelope.payload as { boardId: string; shapeId: string; clientOpId: string };
      const roomId = await this.boardRoomId(user.id, payload.boardId);

      const outcome = await this.boardService.deleteShape(user.id, {
        boardId: payload.boardId,
        shapeId: payload.shapeId,
        clientOpId: payload.clientOpId,
      });
      this.settleWriteOutcome(
        socket,
        roomId,
        envelope,
        payload.clientOpId,
        outcome,
        SERVER_EVENTS.SHAPE_DELETED,
      );
    });
  }

  @SubscribeMessage(CLIENT_EVENTS.SHAPE_BATCH)
  async onShapeBatch(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    await this.guardWrite(socket, body, CLIENT_EVENTS.SHAPE_BATCH, async (envelope) => {
      const user = this.requireUser(socket);
      if (!(await this.consumeWrite(socket, user.id))) return;
      const payload = envelope.payload as { boardId: string; ops: ShapeOp[] };
      const roomId = await this.boardRoomId(user.id, payload.boardId);

      // 整批原子：被拒时 applyBatch 抛 AppError（内含"哪一条为什么失败"），
      // 由 guardWrite 统一翻成 shape:rejected，这里不需要再兜一层
      const outcomes = await this.boardService.applyBatch(user.id, {
        boardId: payload.boardId,
        ops: payload.ops,
      });

      const seqs: Record<string, number> = {};
      for (const outcome of outcomes) {
        const clientOpId = outcome.status === 'applied' ? outcome.op.clientOpId : '';
        if (outcome.status === 'applied') seqs[clientOpId] = outcome.seq;
        else if (outcome.status === 'duplicate' && outcome.seq > 0) seqs[clientOpId] = outcome.seq;
      }
      this.emit(socket, SERVER_EVENTS.SHAPE_ACK, {
        reqId: envelope.reqId ?? '',
        clientOpId: payload.ops[0]?.clientOpId ?? '',
        seqs,
        serverShape: null,
      });
      // ack 之后才广播：其余客户端看到的每条 op 都对应已提交的事务
      for (const outcome of outcomes) {
        if (outcome.status !== 'applied') continue;
        this.broadcastExcept(
          socket,
          roomId,
          this.broadcastEventFor(outcome.op.opType),
          { seq: outcome.seq, op: toWireOp(outcome.op) },
          { seq: outcome.seq },
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // 瞬时通道
  // -------------------------------------------------------------------------

  @SubscribeMessage(CLIENT_EVENTS.CURSOR_MOVE)
  async onCursorMove(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    await this.guard(socket, body, CLIENT_EVENTS.CURSOR_MOVE, async (envelope) => {
      const user = this.requireUser(socket);
      const { boardId, x, y, tool } = envelope.payload as {
        boardId: string;
        x: number;
        y: number;
        tool?: string;
      };
      const allowed = await this.rateLimit.consume(`cursor:${user.id}`, CURSOR_RATE);
      if (!allowed) return; // 光标是尽力而为通道：超限直接丢，不回错误，避免放大流量

      const roomId = await this.boardRoomId(user.id, boardId);
      this.scheduleCursorBroadcast(socket, roomId, x, y, tool);
    });
  }

  // -------------------------------------------------------------------------
  // 内部：鉴权 / 限流 / 结果投递
  // -------------------------------------------------------------------------

  private async authenticate(socket: AppSocket): Promise<void> {
    const token = extractWsToken(socket.handshake);
    if (!token) throw new AppError(ERROR_CODES.UNAUTHENTICATED, '缺少访问令牌', 401);
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; email: string }>(token);
      socket.data.user = { id: payload.sub, email: payload.email };
    } catch {
      throw new AppError(ERROR_CODES.UNAUTHENTICATED, '访问令牌无效或已过期', 401);
    }
  }

  private wsAuthError(error: unknown): Error {
    const appErrorCode = error instanceof AppError ? error.code : ERROR_CODES.UNAUTHENTICATED;
    const message = error instanceof Error ? error.message : '未通过鉴权';
    const err = new Error(appErrorCode) as Error & { data?: unknown };
    err.data = { code: appErrorCode, message };
    return err;
  }

  private requireUser(socket: AppSocket): { id: string; email: string } {
    const user = socket.data.user;
    if (!user) throw new AppError(ERROR_CODES.UNAUTHENTICATED, '连接未通过鉴权', 401);
    return user;
  }

  /** 统一的消息入口：校验 → 执行 → 把领域错误翻成协议错误 */
  private async guard(
    socket: AppSocket,
    body: unknown,
    expectedType: ClientEventName,
    handler: (envelope: ClientEnvelope) => Promise<void>,
  ): Promise<void> {
    const parsed = parseIncoming(body, expectedType);
    if (!parsed.ok) {
      this.emitError(socket, parsed.error);
      return;
    }
    try {
      await handler(parsed.envelope);
    } catch (error) {
      this.emitError(socket, this.toErrorPayload(error, parsed.envelope));
    }
  }

  /**
   * 写操作的入口：与 guard 唯一的不同在错误出口——
   * 写失败（含授权/校验/冲突任何一层抛出的 AppError）一律回 `shape:rejected`：
   * 客户端要拿着 clientOpId 回滚本地乐观状态，而 error 事件属于控制通道，
   * 客户端不会用它来对账 pending 队列（§6.5-4）。
   */
  private async guardWrite(
    socket: AppSocket,
    body: unknown,
    expectedType: ClientEventName,
    handler: (envelope: ClientEnvelope) => Promise<void>,
  ): Promise<void> {
    const parsed = parseIncoming(body, expectedType);
    if (!parsed.ok) {
      this.emitError(socket, parsed.error);
      return;
    }
    try {
      await handler(parsed.envelope);
    } catch (error) {
      this.emitRejected(socket, parsed.envelope, extractClientOpId(parsed.envelope.payload), error);
    }
  }

  /** 写操作限流（§7.7：60/s 令牌桶，Redis 计数支持多实例） */
  private async consumeWrite(socket: AppSocket, userId: string): Promise<boolean> {
    const allowed = await this.rateLimit.consume(`write:${userId}`, WRITE_RATE);
    if (!allowed) {
      this.emitError(socket, {
        code: ERROR_CODES.RATE_LIMITED,
        message: '写操作过于频繁，请稍后重试',
      });
      return false;
    }
    return true;
  }

  /** 查 board 所属房间：广播目标需要，同时复用一次授权校验（BoardService 内还会再查一次） */
  private async boardRoomId(userId: string, boardId: string): Promise<string> {
    const { roomId } = await this.roomService.assertBoardAccess(userId, boardId);
    return roomId;
  }

  /**
   * 写结果投递：applied → ack + 广播；duplicate → 只 ack（不重复广播，§6.5-1）；
   * rejected → shape:rejected（带最新 serverShape，客户端据此重放/回滚）。
   */
  private settleWriteOutcome(
    socket: AppSocket,
    roomId: string,
    envelope: ClientEnvelope,
    clientOpId: string,
    outcome: WriteOutcome,
    broadcastEvent: ServerEventName,
  ): void {
    if (outcome.status === 'rejected') {
      this.emit(socket, SERVER_EVENTS.SHAPE_REJECTED, {
        reqId: envelope.reqId ?? '',
        clientOpId,
        reason: outcome.code,
        message: outcome.message,
        serverShape: outcome.serverShape ? toWireShape(outcome.serverShape) : null,
      });
      return;
    }

    this.emit(
      socket,
      SERVER_EVENTS.SHAPE_ACK,
      {
        reqId: envelope.reqId ?? '',
        clientOpId,
        // duplicate 且拿不到 seq（按 shapeId 命中）时省略 seq，客户端只需知道"已生效"
        ...(outcome.seq > 0 ? { seq: outcome.seq } : {}),
        serverShape: outcome.serverShape ? toWireShape(outcome.serverShape) : null,
      },
      outcome.seq > 0 ? { seq: outcome.seq } : undefined,
    );

    if (outcome.status === 'applied') {
      this.broadcastExcept(
        socket,
        roomId,
        broadcastEvent,
        { seq: outcome.seq, op: toWireOp(outcome.op) },
        { seq: outcome.seq },
      );
    }
  }

  private broadcastEventFor(opType: ShapeOp['opType']): ServerEventName {
    switch (opType) {
      case 'create':
        return SERVER_EVENTS.SHAPE_CREATED;
      case 'update':
      case 'reorder':
        return SERVER_EVENTS.SHAPE_UPDATED;
      case 'delete':
        return SERVER_EVENTS.SHAPE_DELETED;
      default:
        return SERVER_EVENTS.SHAPE_UPDATED;
    }
  }

  private emitRejected(
    socket: AppSocket,
    envelope: ClientEnvelope,
    clientOpId: string,
    error: unknown,
  ): void {
    const payload = this.toErrorPayload(error, envelope);
    this.emit(socket, SERVER_EVENTS.SHAPE_REJECTED, {
      reqId: envelope.reqId ?? '',
      clientOpId,
      reason: payload.code,
      message: payload.message,
      serverShape: null,
    });
  }

  /** 补齐 result → board:ops / board:state（§6.6） */
  private emitSync(socket: AppSocket, sync: SyncResult, boardId: string): void {
    if (sync.kind === 'ops') {
      this.emit(socket, SERVER_EVENTS.BOARD_OPS, {
        boardId,
        fromSeq: sync.fromSeq ?? sync.latestSeq + 1,
        ops: sync.ops ?? [],
        latestSeq: sync.latestSeq,
      });
      return;
    }
    this.emit(socket, SERVER_EVENTS.BOARD_STATE, {
      boardId,
      seq: sync.latestSeq,
      shapes: sync.shapes ?? [],
    });
  }

  /** room:join 后的状态下发：带 sinceSeq 尝试增量，否则全量 */
  private async deliverBoard(socket: AppSocket, boardId: string, sinceSeq?: number): Promise<void> {
    const user = this.requireUser(socket);
    if (sinceSeq === undefined) {
      const state = await this.boardService.getState(user.id, boardId);
      this.emit(socket, SERVER_EVENTS.BOARD_STATE, state);
      return;
    }
    const sync = await this.boardService.sync(user.id, boardId, sinceSeq);
    this.emitSync(socket, sync, boardId);
  }

  private scheduleCursorBroadcast(
    socket: AppSocket,
    roomId: string,
    x: number,
    y: number,
    tool?: string,
  ): void {
    const existing = this.cursorPending.get(socket.id);
    if (existing) {
      // 合并窗口内只更新位置，定时器不重置——保证 40ms 内一定有一次广播
      existing.roomId = roomId;
      existing.x = x;
      existing.y = y;
      if (tool !== undefined) existing.tool = tool;
      return;
    }
    const timer = setTimeout(() => {
      this.cursorPending.delete(socket.id);
      const user = socket.data.user;
      if (!user) return;
      const event = makeServerEnvelope(
        SERVER_EVENTS.CURSOR_UPDATED,
        { userId: user.id, x, y, ...(tool !== undefined ? { tool } : {}) },
        { roomId },
      );
      socket.to(roomChannel(roomId)).emit(SERVER_EVENTS.CURSOR_UPDATED, event);
      void this.presence.setCursor(roomId, user.id, {
        x,
        y,
        ...(tool !== undefined ? { tool } : {}),
      });
    }, CURSOR_THROTTLE_MS);
    timer.unref?.();
    this.cursorPending.set(socket.id, { roomId, x, y, tool, timer });
  }

  /** 离开房间：presence 计数归零时才广播 presence:left（多标签页场景） */
  private async leaveRoom(socket: AppSocket, roomId: string): Promise<void> {
    const user = socket.data.user;
    socket.data.rooms.delete(roomId);
    if (!user) return;
    const { gone } = await this.presence.leave(roomId, user.id);
    if (!gone) return;
    this.broadcast(roomId, SERVER_EVENTS.PRESENCE_LEFT, { userId: user.id });
    const members = await this.presence.list(roomId);
    this.broadcast(roomId, SERVER_EVENTS.PRESENCE_LIST, { roomId, members });
    this.logger.debug({ roomId, userId: user.id }, '用户离开房间');
  }

  // -------------------------------------------------------------------------
  // 内部：信封与错误
  // -------------------------------------------------------------------------

  private emit<T extends ServerEventName>(
    socket: AppSocket,
    type: T,
    payload: ServerPayload<T>,
    opts?: { roomId?: string; seq?: number },
  ): void {
    socket.emit(type, makeServerEnvelope(type, payload, opts));
  }

  private broadcast<T extends ServerEventName>(
    roomId: string,
    type: T,
    payload: ServerPayload<T>,
    opts?: { seq?: number },
  ): void {
    this.server
      .to(roomChannel(roomId))
      .emit(type, makeServerEnvelope(type, payload, { roomId, ...opts }) as ServerEnvelope<T>);
  }

  private broadcastExcept<T extends ServerEventName>(
    socket: AppSocket,
    roomId: string,
    type: T,
    payload: ServerPayload<T>,
    opts?: { seq?: number },
  ): void {
    // socket.to(room) 语义：除发送者之外的所有房间成员（含其他实例上的连接）
    socket
      .to(roomChannel(roomId))
      .emit(type, makeServerEnvelope(type, payload, { roomId, ...opts }) as ServerEnvelope<T>);
  }

  private emitError(socket: AppSocket, payload: ErrorPayload): void {
    socket.emit(SERVER_EVENTS.ERROR, makeServerEnvelope(SERVER_EVENTS.ERROR, payload));
  }

  private toErrorPayload(error: unknown, envelope?: ClientEnvelope): ErrorPayload {
    if (error instanceof AppError) {
      return { code: error.code, message: error.message };
    }
    this.logger.error({ err: error, type: envelope?.type, reqId: envelope?.reqId }, 'WS 处理异常');
    return { code: ERROR_CODES.INTERNAL, message: '服务器内部错误' };
  }
}

/** 供测试与外部使用的错误码类型再导出 */
export type { ErrorCode };
