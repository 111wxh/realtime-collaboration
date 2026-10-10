/**
 * Socket 连接管理（单例）：一个浏览器标签页维持一条 socket.io 连接。
 *
 * - 握手鉴权走 `auth: { token }`（access token 走协议，不依赖 cookie）；
 * - token 变化（重新登录 / 刷新后换了 token）→ 原地换 auth 并重连，不新建实例；
 * - 自动重连交给 socket.io（指数退避），我们只监听状态并转发给上层；
 * - 下行消息统一用 shared 的 parseServerEnvelope 解析（类型收窄 + 运行期防护），
 *   解析失败的报文直接丢弃并打日志，不让脏数据污染状态机。
 */
import type { ClientEnvelope, ClientEventName, ServerEnvelope } from '@collab/shared';
import { parseServerEnvelope } from '@collab/shared';
import { io, type Socket } from 'socket.io-client';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

/** WS 地址：优先专用变量，其次 API 地址，最后回落到同源 */
export function resolveWsUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit;
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (apiUrl) return apiUrl;
  if (typeof window !== 'undefined') return window.location.origin;
  return 'http://localhost:3001';
}

type EnvelopeHandler = (envelope: ServerEnvelope) => void;
type StatusHandler = (status: ConnectionStatus) => void;

export class SocketConnection {
  private socket: Socket | null = null;

  private token: string | null = null;

  private readonly envelopeHandlers = new Set<EnvelopeHandler>();

  private readonly statusHandlers = new Set<StatusHandler>();

  private status: ConnectionStatus = 'idle';

  /** 保证 connect() 幂等：同一个 token 重复调用不会重建连接 */
  connect(token: string): void {
    if (!token) return;
    if (this.socket && this.token === token) {
      if (!this.socket.connected) this.socket.connect();
      return;
    }
    if (this.socket) {
      // token 变了：拆掉旧连接（旧握手已经失效）
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.token = token;
    this.setStatus('connecting');
    const socket = io(resolveWsUrl(), {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 8000,
    });
    this.socket = socket;

    socket.on('connect', () => this.setStatus('connected'));
    socket.on('disconnect', (reason) => {
      this.setStatus(reason === 'io client disconnect' ? 'idle' : 'reconnecting');
    });
    socket.io.on('reconnect_attempt', () => this.setStatus('reconnecting'));
    socket.on('connect_error', () => this.setStatus('reconnecting'));
    // 所有下行事件都从 onAny 进来：信封自带 type，一个入口做解析与分发
    socket.onAny((_event: string, ...args: unknown[]) => {
      const raw = args.length === 1 ? args[0] : { event: _event, args };
      const parsed = parseServerEnvelope(raw);
      if (!parsed.ok) {
        console.warn('[socket] 无法解析的下行消息，已丢弃', parsed.error, raw);
        return;
      }
      for (const handler of this.envelopeHandlers) handler(parsed.envelope);
    });
  }

  disconnect(): void {
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
    this.token = null;
    this.setStatus('idle');
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  /** 发一条上行消息：信封由 shared 的 makeClientEnvelope 构造好再传进来 */
  emitEnvelope(envelope: ClientEnvelope<ClientEventName>): void {
    if (!this.socket) return;
    this.socket.emit(envelope.type, envelope);
  }

  onEnvelope(handler: EnvelopeHandler): () => void {
    this.envelopeHandlers.add(handler);
    return () => this.envelopeHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
  }
}

/** 单例：整个标签页共用一条连接（房间切换只发 room:leave / room:join） */
let sharedConnection: SocketConnection | null = null;

export function getSocketConnection(): SocketConnection {
  if (!sharedConnection) sharedConnection = new SocketConnection();
  return sharedConnection;
}
