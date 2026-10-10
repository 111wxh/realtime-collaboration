'use client';

/**
 * 白板页外壳：顶栏（房间名 / 邀请码 / 在线成员 / 返回）+ 画布 + 工具栏 + 提示条。
 *
 * 生命周期：进入页面 → connect（建 WS + room:join，带 sinceSeq 走增量补齐），离开 → disconnect。
 */
import { ChevronLeft, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';

import { useBoardStore } from '../../stores/board';
import { useSessionStore } from '../../stores/session';
import type { Room } from '../../lib/types';
import { BoardCanvas } from './BoardCanvas';
import { PresenceBar } from './PresenceBar';
import { Toolbar } from './Toolbar';

export function BoardView({ room, boardId }: { room: Room; boardId: string }) {
  const connect = useBoardStore((state) => state.connect);
  const disconnect = useBoardStore((state) => state.disconnect);
  const notices = useBoardStore((state) => state.notices);
  const dismissNotice = useBoardStore((state) => state.dismissNotice);
  const expireNotices = useBoardStore((state) => state.expireNotices);
  const ready = useBoardStore((state) => state.ready);

  useEffect(() => {
    const user = useSessionStore.getState().user;
    if (!user) return () => undefined;
    connect({ roomId: room.id, boardId, user });
    return () => disconnect();
  }, [room.id, boardId, connect, disconnect]);

  // 提示条 4 秒后自动消失（按时间戳批量清理，避免每条提示各自维护定时器）
  useEffect(() => {
    const timer = window.setInterval(() => expireNotices(4000), 1000);
    return () => window.clearInterval(timer);
  }, [expireNotices]);

  return (
    <div className="board-shell flex flex-col bg-app">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-panel px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/rooms"
            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-app hover:text-ink"
            title="返回房间列表"
          >
            <ChevronLeft size={18} />
          </Link>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{room.name}</p>
            <p className="text-[11px] text-muted">{ready ? '画布已连接' : '正在加载画布…'}</p>
          </div>
        </div>
        <PresenceBar inviteCode={room.inviteCode} />
      </header>

      <div className="relative grow overflow-hidden">
        <BoardCanvas />
        <Toolbar />
        {/* 提示条：同步降级、冲突重试、拒绝原因都在这里露头 */}
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 flex w-[min(560px,90vw)] -translate-x-1/2 flex-col gap-2">
          {notices.map((notice) => (
            <div
              key={notice.id}
              className={
                notice.level === 'error'
                  ? 'pointer-events-auto flex items-start justify-between gap-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger shadow-sm'
                  : notice.level === 'warn'
                    ? 'pointer-events-auto flex items-start justify-between gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink shadow-sm'
                    : 'pointer-events-auto flex items-start justify-between gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-muted shadow-sm'
              }
            >
              <span>{notice.text}</span>
              <button
                type="button"
                onClick={() => dismissNotice(notice.id)}
                className="shrink-0 text-xs opacity-70 hover:opacity-100"
                aria-label="关闭提示"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
