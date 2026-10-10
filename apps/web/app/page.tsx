'use client';

/**
 * 首页：按会话状态分流 —— 已登录去房间列表，未登录去登录页。
 * 真正的判断在 client 侧（access token 只在内存里），所以这里是客户端重定向。
 */
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { FullscreenHint } from '../components/ui';
import { useSessionStore } from '../stores/session';

export default function Home() {
  const status = useSessionStore((state) => state.status);
  const router = useRouter();

  useEffect(() => {
    if (status === 'authed') router.replace('/rooms');
    else if (status === 'anon') router.replace('/login');
  }, [status, router]);

  return <FullscreenHint text={status === 'authed' ? '正在进入房间列表…' : '正在恢复会话…'} />;
}
