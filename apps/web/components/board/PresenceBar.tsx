'use client';

/**
 * 在线状态栏：成员头像栈 + 连接状态 + 未同步 op 数（pending）。
 */
import { clsx } from 'clsx';
import { Link2, Wifi, WifiOff } from 'lucide-react';

import { useBoardStore } from '../../stores/board';
import { usePresenceStore } from '../../stores/presence';
import { useSessionStore } from '../../stores/session';
import { Avatar, CopyButton } from '../ui';

export function PresenceBar({ inviteCode }: { inviteCode?: string }) {
  const members = usePresenceStore((state) => state.members);
  const status = useBoardStore((state) => state.status);
  const pendingCount = useBoardStore((state) => state.sync.pending.length);
  const selfId = useSessionStore((state) => state.user?.id);

  const list = Object.values(members);
  const visible = list.slice(0, 6);
  const overflow = list.length - visible.length;

  const online = status === 'connected';

  return (
    <div className="flex items-center gap-3">
      {/* 连接状态 + 同步积压 */}
      <div
        className={clsx(
          'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
          online
            ? 'border-line bg-panel text-muted'
            : 'border-danger/30 bg-danger-soft text-danger',
        )}
        title={online ? '实时连接正常' : '连接已断开，恢复后会自动补齐'}
      >
        {online ? <Wifi size={13} /> : <WifiOff size={13} />}
        <span>{online ? '实时' : status === 'reconnecting' ? '重连中' : '离线'}</span>
        {pendingCount > 0 ? <span className="text-muted">· {pendingCount} 待确认</span> : null}
      </div>

      {inviteCode ? (
        <div className="flex items-center gap-1 rounded-full border border-line bg-panel px-2.5 py-1 text-xs text-muted">
          <Link2 size={13} />
          {/* 只放邀请码本身：文案放 title，复制按钮在右侧（e2e 从这里读码） */}
          <span
            data-testid="invite-code"
            title="邀请码（点右侧按钮复制）"
            className="font-mono tracking-wide text-ink"
          >
            {inviteCode}
          </span>
          <CopyButton value={inviteCode} label="" />
        </div>
      ) : null}

      {/* 头像栈 + 在线人数（人数单独成节点，e2e 与读屏都能直接用） */}
      <div className="flex items-center">
        {visible.map((member) => (
          <span key={member.userId} className="-ml-1.5 first:ml-0">
            <Avatar
              name={member.displayName}
              color={member.avatarColor}
              size={30}
              title={member.userId === selfId ? `${member.displayName}（我）` : member.displayName}
            />
          </span>
        ))}
        {overflow > 0 ? (
          <span className="-ml-1.5 inline-grid h-[30px] w-[30px] place-items-center rounded-full bg-app text-[11px] text-muted ring-2 ring-panel">
            +{overflow}
          </span>
        ) : null}
        <span
          data-testid="presence-count"
          title="当前在线人数"
          aria-label={`当前在线 ${list.length} 人`}
          className="ml-2 text-xs text-muted tabular-nums"
        >
          {list.length}
        </span>
      </div>
    </div>
  );
}
