/**
 * 登录页的 e2e 关键路径：注册 tab 可切换、注册表单可填、提交后进 /rooms。
 * 顺带验证 label 与输入框的关联（e2e 用 getByLabel(/邮箱|密码|昵称/) 抓元素）。
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '../../stores/session';

const routerReplace = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplace, push: routerPush, refresh: vi.fn() }),
}));

// 页面在模块加载时就会 import store（store 又会 configureApi），这里在 import 之前不需要特殊处理
import LoginPage from '../../app/login/page';

function mockFetchJson(status: number, body: unknown): void {
  vi.stubGlobal('fetch', async () => {
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

beforeEach(() => {
  routerReplace.mockReset();
  routerPush.mockReset();
  act(() => {
    useSessionStore.setState({ status: 'anon', user: null, accessToken: null, error: null });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('登录 / 注册页', () => {
  it('默认是登录表单，切到注册后多出昵称输入框', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    expect(screen.getByLabelText('邮箱')).toBeInTheDocument();
    expect(screen.getByLabelText('密码')).toBeInTheDocument();
    expect(screen.queryByLabelText('昵称')).toBeNull();

    await user.click(screen.getByRole('button', { name: '注册' }));
    expect(screen.getByLabelText('昵称')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注册并进入' })).toBeInTheDocument();
  });

  it('注册成功：直接用响应里的 accessToken 落会话并跳转 /rooms', async () => {
    mockFetchJson(201, {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'a@b.c',
        displayName: '用户A',
        avatarColor: '#4c8dff',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      accessToken: 'token-from-register',
    });

    const user = userEvent.setup();
    render(<LoginPage />);
    await user.click(screen.getByRole('button', { name: '注册' }));
    await user.type(screen.getByLabelText('昵称'), '用户A');
    await user.type(screen.getByLabelText('邮箱'), 'a@b.c');
    await user.type(screen.getByLabelText('密码'), 'password1');
    await user.click(screen.getByRole('button', { name: '注册并进入' }));

    await vi.waitFor(() => {
      expect(useSessionStore.getState().status).toBe('authed');
    });
    expect(useSessionStore.getState().accessToken).toBe('token-from-register');
    expect(routerReplace).toHaveBeenCalledWith('/rooms');
  });

  it('重复邮箱：错误提示走错误码映射的中文文案', async () => {
    mockFetchJson(409, { code: 'ALREADY_EXISTS', message: 'email exists' });

    const user = userEvent.setup();
    render(<LoginPage />);
    await user.click(screen.getByRole('button', { name: '注册' }));
    await user.type(screen.getByLabelText('昵称'), '用户A');
    await user.type(screen.getByLabelText('邮箱'), 'a@b.c');
    await user.type(screen.getByLabelText('密码'), 'password1');
    await user.click(screen.getByRole('button', { name: '注册并进入' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('该邮箱已被注册');
    expect(useSessionStore.getState().status).toBe('anon');
  });
});
