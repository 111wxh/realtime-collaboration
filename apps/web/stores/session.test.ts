/**
 * 会话 store 的失败描述：这是"后端没起"时用户看到的那句话的来源。
 *
 * 背景：bootstrap() 走 refresh（httpOnly cookie）恢复会话，失败就收敛成未登录。
 * 之前 refresh() 把"网络不可达"和"cookie 失效"一起吞成 null，用户只看到被送回登录页、
 * 不知道为什么。这里钉死：连接失败必须留下一条可读描述。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from './session';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('会话恢复（bootstrap）', () => {
  it('后端不可达：收敛为未登录，并留下可读描述供登录页展示', async () => {
    useSessionStore.setState({ status: 'idle', user: null, accessToken: null, error: null });
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    await useSessionStore.getState().bootstrap();

    const state = useSessionStore.getState();
    expect(state.status).toBe('anon');
    expect(state.accessToken).toBeNull();
    expect(state.error?.message).toContain('无法连接后端服务');
  });

  it('refresh cookie 失效（401）：安静收敛为未登录，不打扰用户', async () => {
    useSessionStore.setState({ status: 'idle', user: null, accessToken: null, error: null });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ code: 'UNAUTHENTICATED', message: '未登录' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    await useSessionStore.getState().bootstrap();

    const state = useSessionStore.getState();
    expect(state.status).toBe('anon');
    expect(state.error).toBeNull();
  });
});
