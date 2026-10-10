'use client';

/**
 * 白板页：先取房间信息（含 boardId 与成员），再交给 BoardView 建立实时连接。
 *
 * 非成员（403）/ 房间不存在（404）都给明确出口，避免用户卡在空白页。
 */
import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ApiError, api } from '../../../lib/api';
import { errorMessage } from '../../../lib/errorMessages';
import type { RoomDetail } from '../../../lib/types';
import { BoardView } from '../../../components/board/BoardView';
import { RequireAuth } from '../../../components/RequireAuth';
import { FullscreenHint } from '../../../components/ui';
import { useSessionStore } from '../../../stores/session';

export default function RoomBoardPage() {
  return (
    <RequireAuth>
      <RoomLoader />
    </RequireAuth>
  );
}

function RoomLoader() {
  const params = useParams<{ roomId: string }>();
  const roomId = typeof params.roomId === 'string' ? params.roomId : '';
  const accessToken = useSessionStore((state) => state.accessToken);
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    setError(null);
    setDetail(null);
    api
      .getRoom(roomId)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError({
            code: err.code,
            message:
              err.code === 'FORBIDDEN'
                ? '你不是该房间的成员，请用邀请码加入'
                : errorMessage(err.code),
          });
        } else {
          setError({ message: '加载房间失败，请确认后端服务已启动' });
        }
      });
    return () => {
      cancelled = true;
    };
    // accessToken 变化时重试（401 链路刷新过 token 的情况下）
  }, [roomId, accessToken]);

  if (error) {
    return (
      <main className="grid min-h-dvh place-items-center p-8">
        <div className="ui-card w-full max-w-sm p-6 text-center">
          <p className="text-sm font-medium text-danger">{error.message}</p>
          <Link href="/rooms" className="ui-btn mt-4 w-full">
            <ChevronLeft size={16} />
            返回房间列表
          </Link>
        </div>
      </main>
    );
  }

  if (!detail) return <FullscreenHint text="正在加载房间…" />;

  // boardId 可能来自响应顶层（冻结契约）或 room.boardId（api 实现）；
  // 都为空的极端情况下留空字符串：WS 的 room:joined 会带回权威 boardId 并覆盖。
  return <BoardView room={detail.room} boardId={detail.boardId ?? ''} />;
}
