'use client';

/**
 * 登录 / 注册页：同一个表单两套提交（切换 tab）。
 *
 * 错误提示统一走"错误码 → 中文文案"（lib/errorMessages.ts），不直接展示服务端 message。
 */
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { describeError } from '../../lib/errorMessages';
import { useSessionStore } from '../../stores/session';
import { ErrorBanner, Spinner } from '../../components/ui';

type Mode = 'login' | 'register';

export default function LoginPage() {
  const router = useRouter();
  const status = useSessionStore((state) => state.status);
  const login = useSessionStore((state) => state.login);
  const register = useSessionStore((state) => state.register);
  // 会话恢复（bootstrap）失败留下的描述：后端不可达时它会是"无法连接后端服务…"，
  // 这样用户看到的就是原因，而不是莫名其妙被送回登录页。
  const sessionError = useSessionStore((state) => state.error);
  const clearSessionError = useSessionStore((state) => state.clearError);

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authed') router.replace('/rooms');
  }, [status, router]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(email.trim(), password);
      } else {
        await register(email.trim(), password, displayName.trim());
      }
      router.replace('/rooms');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // 本地提交错误优先；没有则展示会话恢复留下的描述
  const shownError = error || sessionError?.message || '';

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold">协作白板</h1>
          <p className="mt-1 text-sm text-muted">实时多人白板 · 光标 · 在线状态 · 断线补齐</p>
        </div>

        <div className="ui-card p-6">
          <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-app p-1">
            {(['login', 'register'] as Mode[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => {
                  setMode(item);
                  setError('');
                }}
                className={
                  mode === item
                    ? 'rounded-md bg-panel px-3 py-1.5 text-sm font-medium shadow-sm'
                    : 'rounded-md px-3 py-1.5 text-sm text-muted hover:text-ink'
                }
              >
                {item === 'login' ? '登录' : '注册'}
              </button>
            ))}
          </div>

          <form className="flex flex-col gap-3" onSubmit={submit}>
            {mode === 'register' ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-muted">昵称</span>
                <input
                  className="ui-input"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="白板上的显示名"
                  maxLength={32}
                  required
                  autoComplete="nickname"
                />
              </label>
            ) : null}

            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-muted">邮箱</span>
              <input
                className="ui-input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-muted">密码</span>
              <input
                className="ui-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="至少 8 位"
                minLength={8}
                required
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            </label>

            {shownError ? (
              <ErrorBanner
                message={shownError}
                onDismiss={() => {
                  setError('');
                  clearSessionError();
                }}
              />
            ) : null}

            <button type="submit" className="ui-btn ui-btn-primary mt-1" disabled={busy}>
              {busy ? <Spinner className="text-white" /> : null}
              {mode === 'login' ? '登录' : '注册并进入'}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-xs text-muted">
          第一版按需注册即可，无需邮箱验证；登录态由 refresh token 维持 30 天。
        </p>
      </div>
    </main>
  );
}
