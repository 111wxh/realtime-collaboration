/**
 * REST 客户端：统一错误形状 {code,message}、自动带 access token、401 自动 refresh 一次并重放。
 *
 * 关键设计：
 *  - 路径一律相对（`/api/...`），由 next.config.ts 的 rewrites 代理到 API，
 *    同源 → 没有 CORS、httpOnly refresh cookie 也天然生效；容器里靠 API_INTERNAL_URL 覆盖代理目标；
 *  - 本模块不 import store（避免循环依赖）：token 由 stores/session.ts 通过 configureApi 注入；
 *  - refresh 单飞（single-flight）：并发 401 只触发一次刷新，其余请求等同一个 promise。
 */
import { ERROR_CODES, type ErrorCode } from '@collab/shared';

import type { Room, RoomAccess, RoomDetail, RoomMember, User } from './types';

export class ApiError extends Error {
  readonly code: ErrorCode;

  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

interface AuthHooks {
  /** 取当前 access token（内存里的，可能为空） */
  getToken: () => string | null;
  /** 刷新 access token；返回新的 token 或 null（刷新失败） */
  refresh: () => Promise<string | null>;
}

let hooks: AuthHooks | null = null;

/** 由 session store 在模块初始化时注入 */
export function configureApi(next: AuthHooks): void {
  hooks = next;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** 是否带 Authorization（refresh 与 login 不需要） */
  auth?: boolean;
  signal?: AbortSignal;
}

async function parseError(response: Response): Promise<ApiError> {
  let code: ErrorCode = ERROR_CODES.INTERNAL;
  let message = `请求失败（HTTP ${response.status}）`;
  try {
    const data = (await response.json()) as { code?: string; message?: string };
    if (data && typeof data.code === 'string') code = data.code as ErrorCode;
    if (data && typeof data.message === 'string') message = data.message;
  } catch {
    // 非 JSON 错误体：保持兜底文案
  }
  return new ApiError(code, message, response.status);
}

async function send(
  path: string,
  options: RequestOptions,
  token: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth !== false && token) headers.Authorization = `Bearer ${token}`;
  return fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    // refresh_token 是 httpOnly cookie：同源请求必须带 credentials
    credentials: 'include',
    signal: options.signal,
  });
}

/** 基础请求：处理错误体 → ApiError；204 → undefined */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = options.auth === false ? null : (hooks?.getToken() ?? null);
  let response = await send(path, options, token);

  // 401：尝试一次 refresh 后重放（只重放一次，避免死循环）
  if (response.status === 401 && options.auth !== false && hooks) {
    const refreshed = await hooks.refresh();
    if (refreshed) {
      response = await send(path, options, refreshed);
    }
  }

  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// 具体接口
// ---------------------------------------------------------------------------

/** 房间响应里 boardId 可能出现在顶层（冻结契约）或 room.boardId（api 实现） */
function normalizeRoomAccess(body: { room: Room; boardId?: string }): RoomAccess {
  return { room: body.room, boardId: body.boardId ?? body.room.boardId ?? '' };
}

export const api = {
  // 认证
  /** 注册即登录：实现侧同时返回 accessToken 与 user（冻结契约只要求 user） */
  register: (input: { email: string; password: string; displayName: string }) =>
    request<{ user: User; accessToken?: string }>('/api/auth/register', {
      method: 'POST',
      body: input,
      auth: false,
    }),

  login: (input: { email: string; password: string }) =>
    request<{ accessToken: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: input,
      auth: false,
    }),

  /** 用 httpOnly refresh cookie 换新的 access token（实现侧顺带返回 user） */
  refresh: () =>
    request<{ accessToken: string; user?: User }>('/api/auth/refresh', {
      method: 'POST',
      auth: false,
    }),

  logout: () => request<void>('/api/auth/logout', { method: 'POST', auth: false }),

  me: () => request<{ user: User }>('/api/auth/me'),

  // 房间
  createRoom: async (input: { name: string }): Promise<RoomAccess> =>
    normalizeRoomAccess(
      await request<{ room: Room; boardId?: string }>('/api/rooms', {
        method: 'POST',
        body: input,
      }),
    ),

  listRooms: () => request<{ rooms: Room[] }>('/api/rooms'),

  joinRoom: async (input: { inviteCode: string }): Promise<RoomAccess> =>
    normalizeRoomAccess(
      await request<{ room: Room; boardId?: string }>('/api/rooms/join', {
        method: 'POST',
        body: input,
      }),
    ),

  getRoom: async (roomId: string): Promise<RoomDetail> => {
    const body = await request<{ room: Room; boardId?: string; members?: RoomMember[] }>(
      `/api/rooms/${encodeURIComponent(roomId)}`,
    );
    return {
      room: body.room,
      boardId: body.boardId ?? body.room.boardId ?? '',
      members: body.members,
    };
  },

  /**
   * 画布全量状态。正常路径下画布数据来自 WS 的 board:state，
   * 这个接口保留给"WS 连不上时也要能看见内容"的兜底场景。
   */
  getBoardState: (boardId: string) =>
    request<{ boardId: string; seq: number; shapes: unknown[] }>(
      `/api/boards/${encodeURIComponent(boardId)}/state`,
    ),
};
