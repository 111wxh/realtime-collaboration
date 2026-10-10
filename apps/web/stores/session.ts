/**
 * 会话 store：access token 只放内存（不落 localStorage），恢复会话靠 httpOnly refresh cookie。
 *
 * 会话恢复流程（页面刷新 / 新标签页）：
 *   bootstrap() → POST /api/auth/refresh（带 cookie）→ 拿到 accessToken → GET /api/auth/me
 *   失败 → anon（受保护路由把用户送回 /login）
 *
 * lib/api.ts 通过 configureApi 注入 token 读取与刷新能力，避免 api ↔ store 循环依赖。
 */
import type { ErrorCode } from '@collab/shared';
import { create } from 'zustand';

import { ApiError, api, configureApi } from '../lib/api';
import type { User } from '../lib/types';

export type SessionStatus = 'idle' | 'loading' | 'authed' | 'anon';

export interface SessionState {
  status: SessionStatus;
  user: User | null;
  /** 只在内存里，刷新页面即失效（由 refresh cookie 换回） */
  accessToken: string | null;
  error: { code: ErrorCode | string; message: string } | null;

  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<User>;
  register: (email: string, password: string, displayName: string) => Promise<User>;
  logout: () => Promise<void>;
  /** 刷新 access token；返回新 token 或 null */
  refresh: () => Promise<string | null>;
  clearError: () => void;
}

/** refresh 单飞：并发 401 时只发一次刷新请求 */
let refreshInFlight: Promise<string | null> | null = null;

export const useSessionStore = create<SessionState>()((set, get) => ({
  status: 'idle',
  user: null,
  accessToken: null,
  error: null,

  async bootstrap() {
    if (get().status === 'loading' || get().status === 'authed') return;
    set({ status: 'loading', error: null });
    try {
      const token = await get().refresh();
      if (!token) {
        set({ status: 'anon', user: null, accessToken: null });
        return;
      }
      const { user } = await api.me();
      set({ status: 'authed', user, accessToken: token });
    } catch (error) {
      set({ status: 'anon', user: null, accessToken: null });
      if (error instanceof ApiError && error.network) {
        // 后端不可达：把描述留在 store 里，登录页会显示（比静默跳转会清晰得多）
        set({ error: { code: error.code, message: error.message } });
      } else if (!(error instanceof ApiError) || error.status !== 401) {
        console.warn('[session] 恢复会话失败', error);
      }
    }
  },

  async login(email, password) {
    const { accessToken, user } = await api.login({ email, password });
    set({ status: 'authed', accessToken, user, error: null });
    return user;
  },

  async register(email, password, displayName) {
    const result = await api.register({ email, password, displayName });
    // 实现侧"注册即登录"会同时返回 accessToken：直接用，少一次往返；
    // 若只回了 user（冻结契约形状），再补一次 login。
    if (result.accessToken) {
      set({ status: 'authed', accessToken: result.accessToken, user: result.user, error: null });
      return result.user;
    }
    return get().login(email, password);
  },

  async logout() {
    try {
      await api.logout();
    } catch (error) {
      // 退出失败也让本地会话失效：refresh cookie 由服务端负责撤销
      console.warn('[session] 退出请求失败', error);
    }
    set({ status: 'anon', user: null, accessToken: null, error: null });
  },

  async refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const result = await api.refresh();
        // refresh 也可能带回 user（实现侧如此）：顺手落盘，省掉一次 /auth/me
        set(
          result.user
            ? { accessToken: result.accessToken, user: result.user }
            : { accessToken: result.accessToken },
        );
        return result.accessToken;
      } catch (error) {
        // 刷新失败：refresh cookie 失效、或后端根本连不上，两种都收敛成未登录。
        // 区别在描述：连不上时留一条可读提示（否则用户只看到被跳回登录页，不知为何）。
        set({ accessToken: null });
        if (error instanceof ApiError && error.network) {
          set({ error: { code: error.code, message: error.message } });
        }
        if (get().status === 'authed') set({ status: 'anon', user: null });
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  },

  clearError() {
    set({ error: null });
  },
}));

/** 供 api 层取 token / 触发刷新（不引入循环依赖） */
configureApi({
  getToken: () => useSessionStore.getState().accessToken,
  refresh: () => useSessionStore.getState().refresh(),
});
