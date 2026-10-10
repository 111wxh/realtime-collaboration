/**
 * REST 客户端单测：错误体 → ApiError、Authorization 注入、401 自动 refresh 一次并重放。
 *
 * fetch 用 mock，所以不需要后端；这几条正好是"接口形状"和"认证链路"的契约测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api, configureApi } from './api';

interface MockCall {
  url: string;
  init: RequestInit;
}

function mockFetch(
  handler: (call: MockCall) => { status: number; body?: unknown } | Promise<never>,
): MockCall[] {
  const calls: MockCall[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call = { url, init };
    calls.push(call);
    const result = await handler(call);
    // 204 不允许带 body，Response 构造器会直接报错
    if (result.status === 204) return new Response(null, { status: 204 });
    const text = result.body === undefined ? '' : JSON.stringify(result.body);
    return new Response(text, {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

function headersOf(call: MockCall): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

describe('api', () => {
  const refresh = vi.fn<() => Promise<string | null>>();

  beforeEach(() => {
    refresh.mockReset();
    configureApi({ getToken: () => null, refresh });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('登录走 POST 且带 credentials: include（refresh cookie 同源）', async () => {
    const calls = mockFetch(() => ({
      status: 200,
      body: { accessToken: 'token-1', user: { id: 'u1' } },
    }));
    const result = await api.login({ email: 'a@b.c', password: 'password1' });
    expect(result.accessToken).toBe('token-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/auth/login');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.credentials).toBe('include');
    expect(headersOf(calls[0]!)).not.toHaveProperty('Authorization');
  });

  it('已登录请求带 Bearer token，路径保持相对（交给 next rewrites 代理）', async () => {
    configureApi({ getToken: () => 'access-1', refresh });
    const calls = mockFetch(() => ({ status: 200, body: { rooms: [] } }));
    await api.listRooms();
    expect(calls[0]?.url).toBe('/api/rooms');
    expect(headersOf(calls[0]!).Authorization).toBe('Bearer access-1');
  });

  it('错误体 {code,message} 转成 ApiError（前端只认 code）', async () => {
    mockFetch(() => ({ status: 409, body: { code: 'ALREADY_EXISTS', message: '邮箱重复' } }));
    await expect(
      api.register({ email: 'a@b.c', password: 'password1', displayName: 'a' }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', status: 409 });
  });

  it('401 → refresh 一次 → 重放原请求成功', async () => {
    let token = 'stale';
    configureApi({
      getToken: () => token,
      refresh: async () => {
        token = 'fresh';
        return 'fresh';
      },
    });
    const calls = mockFetch((call) =>
      headersOf(call).Authorization === 'Bearer fresh'
        ? { status: 200, body: { rooms: [{ id: 'r1' }] } }
        : { status: 401, body: { code: 'UNAUTHENTICATED', message: '过期' } },
    );

    const result = await api.listRooms();
    expect(result.rooms).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(headersOf(calls[0]!).Authorization).toBe('Bearer stale');
    expect(headersOf(calls[1]!).Authorization).toBe('Bearer fresh');
  });

  it('401 → refresh 失败 → 抛 UNAUTHENTICATED，不无限重试', async () => {
    configureApi({ getToken: () => 'stale', refresh: async () => null });
    const calls = mockFetch(() => ({
      status: 401,
      body: { code: 'UNAUTHENTICATED', message: '过期' },
    }));

    await expect(api.listRooms()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(calls).toHaveLength(1); // 只发了一次，没有重放
  });

  it('刷新接口本身不会触发递归刷新', async () => {
    let refreshCalls = 0;
    configureApi({
      getToken: () => 'stale',
      refresh: async () => {
        refreshCalls += 1;
        return null;
      },
    });
    const calls = mockFetch(() => ({ status: 401, body: { code: 'UNAUTHENTICATED' } }));
    await expect(api.refresh()).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
    expect(refreshCalls).toBe(0);
  });

  it('204 无响应体返回 undefined（logout）', async () => {
    mockFetch(() => ({ status: 204 }));
    await expect(api.logout()).resolves.toBeUndefined();
  });

  it('非 JSON 错误体也能抛 ApiError 兜底', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>502</html>', { status: 502 }));
    await expect(api.me()).rejects.toMatchObject({ status: 502, code: 'INTERNAL' });
  });

  it('房间相关接口的路径与编码正确', async () => {
    configureApi({ getToken: () => 'access-1', refresh });
    const calls = mockFetch(() => ({ status: 200, body: { room: {}, boardId: 'b' } }));
    await api.getRoom('room-1');
    expect(calls[0]?.url).toBe('/api/rooms/room-1');
    await api.getBoardState('board-1');
    expect(calls[1]?.url).toBe('/api/boards/board-1/state');
  });

  it('boardId 兼容两种响应形状：顶层字段 或 room.boardId', async () => {
    // 冻结契约：boardId 在顶层
    mockFetch(() => ({
      status: 200,
      body: { room: { id: 'r1', boardId: 'from-room' }, boardId: 'top' },
    }));
    const created = await api.createRoom({ name: 'x' });
    expect(created.boardId).toBe('top');

    // apps/api 的实现：只有 room.boardId
    mockFetch(() => ({ status: 200, body: { room: { id: 'r2', boardId: 'from-room' } } }));
    const joined = await api.joinRoom({ inviteCode: 'ABCD2345' });
    expect(joined.boardId).toBe('from-room');

    mockFetch(() => ({ status: 200, body: { room: { id: 'r3', boardId: 'board-3' } } }));
    const detail = await api.getRoom('r3');
    expect(detail.boardId).toBe('board-3');
    expect(detail.room.id).toBe('r3');
  });

  it('注册响应带 accessToken 时可直接使用（实现侧"注册即登录"）', async () => {
    mockFetch(() => ({
      status: 201,
      body: { user: { id: 'u1', displayName: 'A' }, accessToken: 'token-from-register' },
    }));
    const result = await api.register({ email: 'a@b.c', password: 'password1', displayName: 'A' });
    expect(result.accessToken).toBe('token-from-register');
    expect(result.user.id).toBe('u1');
  });

  it('join 只回 {room, alreadyMember} 时也能拿到 room', async () => {
    mockFetch(() => ({
      status: 200,
      body: { room: { id: 'r9', name: '房间', inviteCode: 'ABCD2345' }, alreadyMember: true },
    }));
    const access = await api.joinRoom({ inviteCode: 'abcd2345' });
    expect(access.room.name).toBe('房间');
    expect(access.boardId).toBe('');
  });

  it('连接失败（fetch 抛错）→ ApiError.network=true 且描述可读，不再透出 "Failed to fetch"', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    await expect(api.refresh()).rejects.toMatchObject({
      network: true,
      status: 0,
      message: expect.stringContaining('无法连接后端服务'),
    });
  });

  it('调用方主动取消（AbortError）不被当成连接失败', async () => {
    vi.stubGlobal('fetch', async () => {
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      throw abort;
    });

    await expect(api.listRooms()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('代理在后端不可达时回的 500（纯文本体）→ 视为连接失败，而不是"服务端出错"', async () => {
    // Next rewrites 代理的真实行为：后端没起时回 500 + "Internal Server Error"
    vi.stubGlobal('fetch', async () => new Response('Internal Server Error', { status: 500 }));

    await expect(api.refresh()).rejects.toMatchObject({
      network: true,
      status: 500,
      message: expect.stringContaining('无法连接后端服务'),
    });
  });

  it('带协议错误体的 5xx 仍是服务端错误（不算连接失败）', async () => {
    mockFetch(() => ({ status: 500, body: { code: 'INTERNAL', message: '炸了' } }));

    await expect(api.me()).rejects.toMatchObject({
      network: false,
      status: 500,
      code: 'INTERNAL',
    });
  });
});
