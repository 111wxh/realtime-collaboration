/**
 * 画布实时客户端（同步层与网络层的粘合）：
 *
 *   store 动作 ──commit(specs)──> SyncCore(纯 reducer) ──effects──> socket 发送
 *   socket 下行 ──> SyncCore ──新状态 + effects──> store 落盘（shapes / seq / pending）
 *
 * 职责边界：
 *  - 本类只做"IO 与编排"：信封构造、batch 打包、光标节流、重连补发、presence/光标分发；
 *  - 一切一致性判断（乐观、回滚、seq 对齐、队列降级）都在 sync-core.ts 里，便于单测；
 *  - 通过 BoardSink 接口回写 store，因此本模块不 import 任何 store，避免循环依赖。
 */
import type { ClientEnvelope, ClientEventName, ShapeOp } from '@collab/shared';
import {
  CLIENT_EVENTS,
  makeClientEnvelope,
  SERVER_EVENTS,
  type ServerEnvelope,
} from '@collab/shared';

import type { Tool } from '../board/defaults';
import { newId } from '../board/defaults';
import type { ConnectionStatus, SocketConnection } from './connection';
import type {
  AnySyncAction,
  LocalOpSpec,
  SyncEffect,
  SyncState,
  UndoOpTemplate,
} from './sync-core';
import { chunkOps, MAX_BATCH } from './sync-core';

/** 光标节流间隔（计划书 §6.5：30–50ms 合并发送） */
export const CURSOR_THROTTLE_MS = 40;
/** 他人光标显示时长：超过这个时间没更新就淡出（瞬时通道可丢包） */
export const CURSOR_TTL_MS = 8000;

export interface PresenceMemberInfo {
  userId: string;
  displayName: string;
  avatarColor: string;
}

export interface CursorInfo {
  x: number;
  y: number;
  tool?: string;
  at: number;
}

/** store 需要实现的小接口：读同步状态、写回状态、外部状态回写 */
export interface BoardSink {
  getSync(): SyncState;
  dispatchSync(action: AnySyncAction): SyncEffect[];
  setConnectionStatus(status: ConnectionStatus): void;
  setRoomJoined(payload: { boardId: string; members: PresenceMemberInfo[] }): void;
  upsertMember(member: PresenceMemberInfo): void;
  removeMember(userId: string): void;
  setMembers(members: PresenceMemberInfo[]): void;
  setCursor(userId: string, cursor: CursorInfo): void;
  removeCursor(userId: string): void;
  /** 清掉超时未更新的他人光标（瞬时通道会丢包，靠 TTL 收尾） */
  pruneCursors(ttlMs: number): void;
  pushNotice(level: 'info' | 'warn' | 'error', text: string): void;
}

export interface BoardClientOptions {
  roomId: string;
  boardId: string;
  connection: SocketConnection;
  sink: BoardSink;
  /** 当前用户信息（presence 用） */
  self: PresenceMemberInfo;
}

export class BoardClient {
  private readonly roomId: string;

  private boardId: string;

  private readonly connection: SocketConnection;

  private readonly sink: BoardSink;

  private readonly self: PresenceMemberInfo;

  private unsubscribers: (() => void)[] = [];

  private started = false;

  private cursorTimer: ReturnType<typeof setTimeout> | null = null;

  private pendingCursor: { x: number; y: number; tool: Tool } | null = null;

  private lastCursorSentAt = 0;

  private cursorTtlTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: BoardClientOptions) {
    this.roomId = options.roomId;
    this.boardId = options.boardId;
    this.connection = options.connection;
    this.sink = options.sink;
    this.self = options.self;
  }

  /** 进入房间：订阅下行 + 建连 + room:join（带 sinceSeq 走增量补齐） */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.unsubscribers.push(
      this.connection.onEnvelope((envelope) => this.handleEnvelope(envelope)),
    );
    this.unsubscribers.push(this.connection.onStatus((status) => this.handleStatus(status)));
    this.cursorTtlTimer = setInterval(() => this.sink.pruneCursors(CURSOR_TTL_MS), CURSOR_TTL_MS);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.send(CLIENT_EVENTS.ROOM_LEAVE, { roomId: this.roomId });
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    if (this.cursorTimer) {
      clearTimeout(this.cursorTimer);
      this.cursorTimer = null;
    }
    if (this.cursorTtlTimer) {
      clearInterval(this.cursorTtlTimer);
      this.cursorTtlTimer = null;
    }
  }

  /** 切换 board（同房间多画布时预留） */
  setBoardId(boardId: string): void {
    this.boardId = boardId;
  }

  // -------------------------------------------------------------------------
  // 上行
  // -------------------------------------------------------------------------

  /** 提交一批本地操作（一个 txId = 一次撤销单位） */
  commit(specs: LocalOpSpec[], label: string): void {
    if (specs.length === 0) return;
    this.run({ kind: 'local-ops', ops: specs, txId: newId(), label });
  }

  /** 撤销：把逆操作当作新操作提交（走同一条同步管道） */
  applyUndoInverses(inverses: UndoOpTemplate[]): void {
    const specs: LocalOpSpec[] = [];
    for (const template of inverses) {
      const spec = templateToSpec(template, this.sink.getSync());
      if (spec) specs.push(spec);
    }
    this.commit(specs, 'undo');
  }

  /** 手动请求补齐（例如从后台切回前台） */
  requestSync(sinceSeq?: number): void {
    const seq = sinceSeq ?? this.sink.getSync().seq;
    this.send(CLIENT_EVENTS.BOARD_SYNC, { boardId: this.boardId, sinceSeq: Math.max(0, seq) });
  }

  /** 光标：本地 30–50ms 节流合并发送（瞬时通道，允许丢） */
  sendCursor(x: number, y: number, tool: Tool): void {
    this.pendingCursor = { x, y, tool };
    const now = Date.now();
    const elapsed = now - this.lastCursorSentAt;
    if (elapsed >= CURSOR_THROTTLE_MS) {
      this.flushCursor();
      return;
    }
    if (this.cursorTimer === null) {
      this.cursorTimer = setTimeout(() => {
        this.cursorTimer = null;
        this.flushCursor();
      }, CURSOR_THROTTLE_MS - elapsed);
    }
  }

  private flushCursor(): void {
    const cursor = this.pendingCursor;
    if (!cursor) return;
    this.pendingCursor = null;
    this.lastCursorSentAt = Date.now();
    this.send(CLIENT_EVENTS.CURSOR_MOVE, {
      boardId: this.boardId,
      x: Math.round(cursor.x * 100) / 100,
      y: Math.round(cursor.y * 100) / 100,
      tool: cursor.tool,
    });
  }

  private send<T extends ClientEventName>(
    type: T,
    payload: Parameters<typeof makeClientEnvelope<T>>[1],
  ): void {
    this.connection.emitEnvelope(
      makeClientEnvelope(type, payload, { roomId: this.roomId }) as ClientEnvelope<ClientEventName>,
    );
  }

  // -------------------------------------------------------------------------
  // 下行
  // -------------------------------------------------------------------------

  private handleStatus(status: ConnectionStatus): void {
    this.sink.setConnectionStatus(status);
    if (status !== 'connected') return;
    // 重连成功：先 join（带 sinceSeq，服务端据此回 board:ops 或 board:state），再补发 pending
    this.joinRoom();
    this.run({ kind: 'connected' });
    // 光标立即补一帧，让其他用户看到我们又回来了
    this.flushCursor();
  }

  private joinRoom(): void {
    const sinceSeq = this.sink.getSync().seq;
    this.send(CLIENT_EVENTS.ROOM_JOIN, {
      roomId: this.roomId,
      sinceSeq: sinceSeq > 0 ? sinceSeq : undefined,
    });
  }

  private handleEnvelope(envelope: ServerEnvelope): void {
    switch (envelope.type) {
      case SERVER_EVENTS.ROOM_JOINED: {
        const payload = envelope.payload;
        this.boardId = payload.boardId;
        this.sink.setRoomJoined({
          boardId: payload.boardId,
          members: payload.members.map(toMemberInfo),
        });
        break;
      }
      case SERVER_EVENTS.BOARD_STATE:
        this.run({ kind: 'board-state', payload: envelope.payload });
        break;
      case SERVER_EVENTS.BOARD_OPS:
        this.run({ kind: 'board-ops', payload: envelope.payload });
        break;
      case SERVER_EVENTS.SHAPE_CREATED:
      case SERVER_EVENTS.SHAPE_UPDATED:
      case SERVER_EVENTS.SHAPE_DELETED: {
        const payload = envelope.payload;
        this.run({ kind: 'authority', seq: payload.seq, op: payload.op });
        break;
      }
      case SERVER_EVENTS.SHAPE_ACK:
        this.run({ kind: 'ack', payload: envelope.payload });
        break;
      case SERVER_EVENTS.SHAPE_REJECTED:
        this.run({ kind: 'reject', payload: envelope.payload });
        break;
      case SERVER_EVENTS.CURSOR_UPDATED: {
        const payload = envelope.payload;
        if (payload.userId === this.self.userId) break;
        this.sink.setCursor(payload.userId, {
          x: payload.x,
          y: payload.y,
          tool: payload.tool,
          at: Date.now(),
        });
        break;
      }
      case SERVER_EVENTS.PRESENCE_JOINED:
        this.sink.upsertMember(toMemberInfo(envelope.payload));
        break;
      case SERVER_EVENTS.PRESENCE_LEFT:
        this.sink.removeMember(envelope.payload.userId);
        this.sink.removeCursor(envelope.payload.userId);
        break;
      case SERVER_EVENTS.PRESENCE_LIST:
        this.sink.setMembers(envelope.payload.members.map(toMemberInfo));
        break;
      case SERVER_EVENTS.ERROR: {
        const payload = envelope.payload;
        this.sink.pushNotice('error', `服务端错误：${payload.code}`);
        // 没权限/未认证：重新 join 一次，让服务端重新授权（可能是成员被移除）
        if (payload.code === 'FORBIDDEN' || payload.code === 'UNAUTHENTICATED') {
          this.joinRoom();
        }
        break;
      }
      default:
        break;
    }
  }

  private run(action: AnySyncAction): void {
    const effects = this.sink.dispatchSync(action);
    this.performEffects(effects);
  }

  /** 执行内核产出的副作用（发送 / 补齐请求） */
  private performEffects(effects: SyncEffect[]): void {
    const toSend: ShapeOp[] = [];
    for (const effect of effects) {
      switch (effect.kind) {
        case 'send':
          toSend.push(...effect.ops);
          break;
        case 'sync':
          this.send(CLIENT_EVENTS.BOARD_SYNC, {
            boardId: this.boardId,
            sinceSeq: Math.max(0, effect.sinceSeq),
          });
          break;
        default:
          // undo-entry / notice 等由 store 在 dispatch 时处理完
          break;
      }
    }
    if (toSend.length === 0) return;
    this.emitOps(toSend);
  }

  /** 单条 op 走专用事件；多条或含 restore/reorder 时打包成 shape:batch */
  private emitOps(ops: ShapeOp[]): void {
    if (!this.connection.isConnected()) {
      // 断线：op 留在 pending 队列里（status 仍是 queued），重连后统一补发
      return;
    }
    if (ops.length === 1) {
      const op = ops[0]!;
      if (op.opType === 'create' && op.shape) {
        this.send(CLIENT_EVENTS.SHAPE_CREATE, {
          boardId: this.boardId,
          shape: op.shape,
          clientOpId: op.clientOpId,
        });
        this.markSent([op.clientOpId]);
        return;
      }
      if (op.opType === 'update' && op.patch) {
        this.send(CLIENT_EVENTS.SHAPE_UPDATE, {
          boardId: this.boardId,
          shapeId: op.shapeId,
          patch: op.patch,
          baseVersion: this.baseVersionFor(op),
          clientOpId: op.clientOpId,
        });
        this.markSent([op.clientOpId]);
        return;
      }
      if (op.opType === 'delete') {
        this.send(CLIENT_EVENTS.SHAPE_DELETE, {
          boardId: this.boardId,
          shapeId: op.shapeId,
          clientOpId: op.clientOpId,
        });
        this.markSent([op.clientOpId]);
        return;
      }
    }
    for (const chunk of chunkOps(ops, MAX_BATCH)) {
      this.send(CLIENT_EVENTS.SHAPE_BATCH, { boardId: this.boardId, ops: chunk });
      this.markSent(chunk.map((op) => op.clientOpId));
    }
  }

  /**
   * update 的 baseVersion：以本地视图里的 version 为准
   * （本地视图的 version 始终是"最后一次服务端确认"的值，见 sync-core 的注释）。
   */
  private baseVersionFor(op: ShapeOp): number {
    const shape = this.sink.getSync().shapes[op.shapeId];
    return shape?.version ?? 1;
  }

  private markSent(clientOpIds: string[]): void {
    if (clientOpIds.length === 0) return;
    this.sink.dispatchSync({ kind: 'sent', clientOpIds });
  }
}

function toMemberInfo(input: {
  userId: string;
  displayName: string;
  avatarColor: string;
}): PresenceMemberInfo {
  return {
    userId: input.userId,
    displayName: input.displayName,
    avatarColor: input.avatarColor,
  };
}

/** 逆操作模板 → 本地操作意图（撤销走的还是同一条同步管道） */
function templateToSpec(template: UndoOpTemplate, state: SyncState): LocalOpSpec | null {
  switch (template.opType) {
    case 'delete':
      return state.shapes[template.shapeId]
        ? { opType: 'delete', shapeId: template.shapeId }
        : null;
    case 'restore':
      return template.shape ? { opType: 'restore', shape: template.shape } : null;
    case 'update':
      return template.patch
        ? { opType: 'update', shapeId: template.shapeId, patch: template.patch }
        : null;
    case 'reorder':
      return template.zIndex !== undefined
        ? { opType: 'reorder', shapeId: template.shapeId, zIndex: template.zIndex }
        : null;
    case 'create':
      return template.shape ? { opType: 'create', shape: template.shape } : null;
    default:
      return null;
  }
}
