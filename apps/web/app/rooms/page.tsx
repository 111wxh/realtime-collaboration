'use client';

/**
 * 房间列表页：列出我的房间 + 创建房间 + 用邀请码加入（显示邀请码并支持一键复制）。
 */
import { LogOut, Plus, RefreshCw, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, api } from '../../lib/api';
import { errorMessage } from '../../lib/errorMessages';
import type { Room } from '../../lib/types';
import { RequireAuth } from '../../components/RequireAuth';
import { Avatar, EmptyState, ErrorBanner, Spinner } from '../../components/ui';
import { useSessionStore } from '../../stores/session';

export default function RoomsPage() {
  return (
    <RequireAuth>
      <RoomsContent />
    </RequireAuth>
  );
}

function RoomsContent() {
  const router = useRouter();
  const user = useSessionStore((state) => state.user);
  const logout = useSessionStore((state) => state.logout);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newRoomName, setNewRoomName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const loadRooms = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.listRooms();
      setRooms(data.rooms);
    } catch (err) {
      setError(err instanceof ApiError ? errorMessage(err.code) : '加载房间列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  const onCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newRoomName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError('');
    try {
      const { room } = await api.createRoom({ name });
      setNewRoomName('');
      router.push(`/rooms/${room.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? errorMessage(err.code) : '创建房间失败');
    } finally {
      setCreating(false);
    }
  };

  const onJoin = async (event: React.FormEvent) => {
    event.preventDefault();
    const code = inviteCode.trim();
    if (!code || joining) return;
    setJoining(true);
    setError('');
    try {
      const { room } = await api.joinRoom({ inviteCode: code });
      setInviteCode('');
      setNotice(`已加入「${room.name}」`);
      router.push(`/rooms/${room.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NOT_FOUND') {
        setError('邀请码无效，请确认后重试');
      } else {
        setError(err instanceof ApiError ? errorMessage(err.code) : '加入房间失败');
      }
    } finally {
      setJoining(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-6 px-5 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">我的房间</h1>
          <p className="mt-0.5 text-sm text-muted">创建一块新白板，或用邀请码加入别人的房间</p>
        </div>
        <div className="flex items-center gap-2">
          {user ? (
            <div className="flex items-center gap-2 rounded-full border border-line bg-panel py-1 pr-3 pl-1">
              <Avatar name={user.displayName} color={user.avatarColor} size={26} />
              <span className="text-sm">{user.displayName}</span>
            </div>
          ) : null}
          <button
            type="button"
            className="ui-btn h-9 px-3 text-xs"
            onClick={() => void logout().then(() => router.replace('/login'))}
          >
            <LogOut size={14} />
            退出
          </button>
        </div>
      </header>

      {error ? <ErrorBanner message={error} onDismiss={() => setError('')} /> : null}
      {notice ? (
        <div className="rounded-lg border border-line bg-accent-soft px-3 py-2 text-sm text-ink">
          {notice}
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2">
        <form className="ui-card flex flex-col gap-3 p-5" onSubmit={onCreate}>
          {/* 表单常驻可见；点这里只做聚焦，按钮名刻意避开"创建房间"以免和 e2e 的提交按钮撞名 */}
          <button
            type="button"
            data-testid="create-room-button"
            className="flex items-center gap-2 self-start text-sm font-medium"
            onClick={() => nameInputRef.current?.focus()}
          >
            <Plus size={15} />
            新建房间
          </button>
          <input
            ref={nameInputRef}
            data-testid="room-name-input"
            className="ui-input"
            value={newRoomName}
            onChange={(event) => setNewRoomName(event.target.value)}
            placeholder="房间名，例如：产品评审"
            aria-label="房间名"
            maxLength={64}
            required
          />
          <button
            type="submit"
            data-testid="create-room-submit"
            className="ui-btn ui-btn-primary"
            disabled={creating}
          >
            {creating ? <Spinner className="text-white" /> : null}
            创建并进入
          </button>
        </form>

        <form className="ui-card flex flex-col gap-3 p-5" onSubmit={onJoin}>
          <div className="flex items-center gap-2 text-sm font-medium">
            <UserPlus size={15} />
            加入房间
          </div>
          <input
            data-testid="invite-code-input"
            className="ui-input font-mono"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
            placeholder="输入邀请码，例如 7K2QF9"
            aria-label="邀请码"
            maxLength={16}
            required
          />
          <button
            type="submit"
            data-testid="join-room-submit"
            className="ui-btn"
            disabled={joining}
          >
            {joining ? <Spinner /> : null}
            加入
          </button>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted">
            全部房间{rooms.length > 0 ? `（${rooms.length}）` : ''}
          </h2>
          <button
            type="button"
            className="ui-btn h-8 px-2 text-xs"
            onClick={() => void loadRooms()}
            disabled={loading}
          >
            {loading ? <Spinner /> : <RefreshCw size={13} />}
            刷新
          </button>
        </div>

        {loading && rooms.length === 0 ? (
          <div className="grid place-items-center rounded-xl border border-line bg-panel py-10 text-sm text-muted">
            <Spinner />
          </div>
        ) : rooms.length === 0 ? (
          <EmptyState
            title="还没有房间"
            description="创建一个房间开始协作，或输入邀请码加入别人的白板。"
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {rooms.map((room) => (
              <li key={room.id}>
                <RoomCard room={room} onEnter={() => router.push(`/rooms/${room.id}`)} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function RoomCard({ room, onEnter }: { room: Room; onEnter: () => void }) {
  const [copied, setCopied] = useState(false);
  const created = new Date(room.createdAt);

  return (
    <div className="ui-card flex h-full flex-col justify-between gap-3 p-4">
      <div>
        {/* 房间名做成链接：既是最自然的"进入白板"入口，也是 e2e 打开房间的抓手 */}
        <Link
          href={`/rooms/${room.id}`}
          className="block truncate text-sm font-medium hover:text-accent"
        >
          {room.name}
        </Link>
        <p className="mt-1 text-xs text-muted">
          创建于 {Number.isNaN(created.getTime()) ? '—' : created.toLocaleString('zh-CN')}
        </p>
      </div>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="rounded-md border border-line px-2 py-1 font-mono text-xs tracking-wide text-muted transition-colors hover:bg-app"
          title="点击复制邀请码"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(room.inviteCode);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            } catch {
              setCopied(false);
            }
          }}
        >
          {/* 只放邀请码本身：避免和其它文本混在一起（也方便复制/测试读取） */}
          <span data-testid="invite-code">{room.inviteCode}</span>
          {copied ? ' 已复制' : ''}
        </button>
        <button type="button" className="ui-btn h-8 px-3 text-xs" onClick={onEnter}>
          打开白板
        </button>
      </div>
    </div>
  );
}
