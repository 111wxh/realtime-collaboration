'use client';

/**
 * 受保护路由：会话未就绪时显示加载态，未登录跳 /login，已登录渲染 children。
 */
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useSessionStore } from '../stores/session';
import { FullscreenHint } from './ui';

export function RequireAuth({ children }: { children: ReactNode }) {
  const status = useSessionStore((state) => state.status);
  const router = useRouter();

  useEffect(() => {
    if (status === 'anon') router.replace('/login');
  }, [status, router]);

  if (status === 'authed') return <>{children}</>;
  return <FullscreenHint text={status === 'anon' ? '正在跳转到登录页…' : '正在恢复会话…'} />;
}
