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

  /**
   * true = 连接层面失败（服务没起 / 断网 / DNS 解析不了），不是服务端返回的业务错误。
   * 调用方据此区分"该让用户改输入"还是"该让用户检查服务是否启动"。
   */
  readonly network: boolean;

  constructor(code: ErrorCode, message: string, status: number, network = false) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.network = network;
  }
}

/**
 * 连接层面失败时的统一描述。fetch 在这种情况下只会抛 "Failed to fetch" / ECONNREFUSED，
 * 对用户毫无信息量，所以在边界上换成一句能指导操作的话。
 */
export const NETWORK_ERROR_MESSAGE = '无法连接后端服务，请确认 API 已启动';

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
  let protocolError = false;
  try {
    const data = (await response.json()) as { code?: string; message?: string };
    if (data && typeof data.code === 'string') {
      code = data.code as ErrorCode;
      protocolError = true;
    }
    if (data && typeof data.message === 'string') message = data.message;
  } catch {
    // 非 JSON 错误体：保持兜底文案
  }

  // 5xx 且响应体不是我们的协议错误形状 → 请求根本没到业务层，属于"后端不可达"。
  // 典型案例：Next 的 rewrites 代理在后端没起时直接回 500 + 纯文本 "Internal Server Error"。
  // 这种情况说"服务端出错了"会误导排查方向，换成连接描述。
  if (!protocolError && response.status >= 500) {
    return new ApiError(ERROR_CODES.INTERNAL, NETWORK_ERROR_MESSAGE, response.status, true);
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

/** AbortError 是调用方主动取消，不该被当成"连不上后端" */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'AbortError'
  );
}

/**
 * 把连接层面的失败（fetch 抛错）翻译成带可读描述的 ApiError。
 * 只有网络/连接失败会走到这里；服务端返回的 4xx/5xx 是正常 Response，不经过本函数。
 */
async function sendSafely(
  path: string,
  options: RequestOptions,
  token: string | null,
): Promise<Response> {
  try {
    return await send(path, options, token);
  } catch (error) {
    if (isAbortError(error) || error instanceof ApiError) throw error;
    console.warn(`[api] 无法连接后端服务：${path}`, error);
    throw new ApiError(ERROR_CODES.INTERNAL, NETWORK_ERROR_MESSAGE, 0, true);
  }
}

/** 基础请求：处理错误体 → ApiError；204 → undefined */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = options.auth === false ? null : (hooks?.getToken() ?? null);
  let response = await sendSafely(path, options, token);

  // 401：尝试一次 refresh 后重放（只重放一次，避免死循环）
  if (response.status === 401 && options.auth !== false && hooks) {
    const refreshed = await hooks.refresh();
    if (refreshed) {
      response = await sendSafely(path, options, refreshed);
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
