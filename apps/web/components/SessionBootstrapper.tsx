'use client';

/**
 * 会话引导：应用挂载时尝试用 refresh cookie 恢复会话（access token 只在内存里，刷新页面必然丢失）。
 * 放在根布局里，所有页面共享一次 bootstrap。
 */
import { useEffect } from 'react';

import { useSessionStore } from '../stores/session';

export function SessionBootstrapper() {
  useEffect(() => {
    void useSessionStore.getState().bootstrap();
  }, []);
  return null;
}
