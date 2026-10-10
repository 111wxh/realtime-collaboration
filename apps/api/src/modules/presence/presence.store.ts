import type { Cursor, PresenceMember } from '@collab/shared';

/**
 * Presence 的存储端口。
 *
 * 两个实现语义完全一致：
 *  - RedisPresenceStore：多实例共享（Hash + TTL），生产路径；
 *  - InMemoryPresenceStore：REDIS_URL 缺失/本地测试用，进程内 Map。
 *
 * 存储里比协议多一个 lastSeenAt 字段，用于识别"实例崩溃后残留的在线用户"；
 * 对外的 list() 不暴露它。
 */
export interface PresenceEntry {
  userId: string;
  displayName: string;
  avatarColor: string;
  cursor?: Cursor | null;
  /** 首次进入房间的时间（ISO），下发给客户端 */
  onlineAt: string;
  /** 最近一次心跳/活动的毫秒时间戳，仅存储内部使用 */
  lastSeenAt: number;
}

export interface PresenceStore {
  /** 返回 alreadyOnline=true 表示该用户在其他连接（可能是另一个实例）上已在线 */
  join(roomId: string, entry: PresenceEntry): Promise<{ alreadyOnline: boolean }>;
  /** 返回 gone=true 表示该用户在本房间已无任何在线连接 */
  leave(roomId: string, userId: string): Promise<{ gone: boolean }>;
  list(roomId: string): Promise<PresenceMember[]>;
  setCursor(roomId: string, userId: string, cursor: Cursor | null): Promise<void>;
  /** 刷新键的 TTL：只有本实例还在服务这些房间时才调用 */
  touch(roomIds: string[]): Promise<void>;
  /** 清掉 lastSeenAt 早于 olderThanMs 的残留成员（崩溃实例留下的），返回清理数 */
  pruneStale(roomId: string, olderThanMs: number): Promise<number>;
}

export function toPresenceMember(entry: PresenceEntry): PresenceMember {
  const member: PresenceMember = {
    userId: entry.userId,
    displayName: entry.displayName,
    avatarColor: entry.avatarColor,
    onlineAt: entry.onlineAt,
  };
  if (entry.cursor) member.cursor = entry.cursor;
  return member;
}

export function parseEntry(raw: string | null | undefined): PresenceEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PresenceEntry;
    if (!parsed || typeof parsed.userId !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 进程内存实现：单实例语义，用于无 Redis 的本地环境与单测 */
export class InMemoryPresenceStore implements PresenceStore {
  private readonly rooms = new Map<
    string,
    Map<string, { entry: PresenceEntry; connections: number }>
  >();

  async join(roomId: string, entry: PresenceEntry): Promise<{ alreadyOnline: boolean }> {
    const room = this.rooms.get(roomId) ?? new Map();
    this.rooms.set(roomId, room);
    const current = room.get(entry.userId);
    if (current) {
      current.entry = { ...entry, onlineAt: current.entry.onlineAt };
      current.connections += 1;
      return { alreadyOnline: true };
    }
    room.set(entry.userId, { entry, connections: 1 });
    return { alreadyOnline: false };
  }

  async leave(roomId: string, userId: string): Promise<{ gone: boolean }> {
    const room = this.rooms.get(roomId);
    const current = room?.get(userId);
    if (!room || !current) return { gone: true };
    current.connections -= 1;
    if (current.connections > 0) return { gone: false };
    room.delete(userId);
    if (room.size === 0) this.rooms.delete(roomId);
    return { gone: true };
  }

  async list(roomId: string): Promise<PresenceMember[]> {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.values()].map((v) => toPresenceMember(v.entry));
  }

  async setCursor(roomId: string, userId: string, cursor: Cursor | null): Promise<void> {
    const current = this.rooms.get(roomId)?.get(userId);
    if (!current) return;
    current.entry.cursor = cursor;
    current.entry.lastSeenAt = Date.now();
  }

  async touch(): Promise<void> {
    // 内存实现没有 TTL，什么也不做
  }

  async pruneStale(roomId: string, olderThanMs: number): Promise<number> {
    const room = this.rooms.get(roomId);
    if (!room) return 0;
    const deadline = Date.now() - olderThanMs;
    let removed = 0;
    for (const [userId, value] of room) {
      if (value.entry.lastSeenAt < deadline) {
        room.delete(userId);
        removed += 1;
      }
    }
    return removed;
  }
}
