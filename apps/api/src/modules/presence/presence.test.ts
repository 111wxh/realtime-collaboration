import { describe, expect, it } from 'vitest';

import { InMemoryPresenceStore } from './presence.store';
import { RedisPresenceStore } from './redis-presence.store';
import { PresenceService } from './presence.service';
import { loadConfig } from '../../common/config';
import type { RedisService } from '../../redis/redis.service';

const ROOM = '00000000-0000-4000-8000-000000000001';
const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

function entry(userId: string, displayName: string) {
  return {
    userId,
    displayName,
    avatarColor: '#4C8DFF',
    cursor: null,
    onlineAt: new Date().toISOString(),
    lastSeenAt: Date.now(),
  };
}

describe('InMemoryPresenceStore（无 Redis 时的降级路径）', () => {
  it('join 后 list 能看到成员；同一用户第二个连接不算重复成员', async () => {
    const store = new InMemoryPresenceStore();
    expect(await store.join(ROOM, entry(USER_A, 'A'))).toEqual({ alreadyOnline: false });
    expect(await store.join(ROOM, entry(USER_A, 'A'))).toEqual({ alreadyOnline: true });
    const members = await store.list(ROOM);
    expect(members).toHaveLength(1);
    expect(members[0]?.displayName).toBe('A');
    // onlineAt 保留首次进入时间
    expect(members[0]?.onlineAt).toBeDefined();
  });

  it('多连接逐个 leave：只有计数归零才算真正离线', async () => {
    const store = new InMemoryPresenceStore();
    await store.join(ROOM, entry(USER_A, 'A'));
    await store.join(ROOM, entry(USER_A, 'A'));
    expect(await store.leave(ROOM, USER_A)).toEqual({ gone: false });
    expect(await store.list(ROOM)).toHaveLength(1);
    expect(await store.leave(ROOM, USER_A)).toEqual({ gone: true });
    expect(await store.list(ROOM)).toHaveLength(0);
  });

  it('setCursor 写进成员信息，list 带出来', async () => {
    const store = new InMemoryPresenceStore();
    await store.join(ROOM, entry(USER_A, 'A'));
    await store.setCursor(ROOM, USER_A, { x: 12, y: 34, tool: 'rect' });
    const members = await store.list(ROOM);
    expect(members[0]?.cursor).toEqual({ x: 12, y: 34, tool: 'rect' });
  });

  it('对不在线的用户 setCursor 是空操作', async () => {
    const store = new InMemoryPresenceStore();
    await store.setCursor(ROOM, USER_A, { x: 1, y: 1 });
    expect(await store.list(ROOM)).toHaveLength(0);
  });

  it('pruneStale 清掉过期的残留记录（崩溃实例留下的）', async () => {
    const store = new InMemoryPresenceStore();
    await store.join(ROOM, entry(USER_A, 'A'));
    await store.join(ROOM, entry(USER_B, 'B'));
    // 把 A 的 lastSeen 手动拨老
    const stale = (
      store as unknown as { rooms: Map<string, Map<string, { entry: { lastSeenAt: number } }>> }
    ).rooms
      .get(ROOM)
      ?.get(USER_A);
    if (stale) stale.entry.lastSeenAt = Date.now() - 10 * 60_000;

    expect(await store.pruneStale(ROOM, 90_000)).toBe(1);
    const members = await store.list(ROOM);
    expect(members.map((m) => m.userId)).toEqual([USER_B]);
  });
});

describe('RedisPresenceStore（用假的 RedisService 验证键设计）', () => {
  /** 极简 Redis 替身：只实现 store 用到的方法，足够验证键名与调用序列 */
  class FakeRedis {
    readonly store = new Map<string, Map<string, string>>();
    readonly expirations = new Map<string, number>();
    readonly calls: string[] = [];

    private hash(key: string): Map<string, string> {
      let h = this.store.get(key);
      if (!h) {
        h = new Map();
        this.store.set(key, h);
      }
      return h;
    }

    async hset(key: string, data: Record<string, string>): Promise<number> {
      this.calls.push(`hset:${key}`);
      for (const [field, value] of Object.entries(data)) this.hash(key).set(field, value);
      return Object.keys(data).length;
    }

    async hget(key: string, field: string): Promise<string | null> {
      return this.hash(key).get(field) ?? null;
    }

    async hgetall(key: string): Promise<Record<string, string>> {
      return Object.fromEntries(this.hash(key));
    }

    async hdel(key: string, ...fields: string[]): Promise<number> {
      this.calls.push(`hdel:${key}`);
      let removed = 0;
      for (const field of fields) {
        if (this.hash(key).delete(field)) removed += 1;
      }
      return removed;
    }

    async hincrby(key: string, field: string, delta: number): Promise<number> {
      this.calls.push(`hincrby:${key}`);
      const next = Number(this.hash(key).get(field) ?? 0) + delta;
      this.hash(key).set(field, String(next));
      return next;
    }

    async expire(key: string, seconds: number): Promise<number> {
      this.expirations.set(key, seconds);
      return 1;
    }
  }

  it('多实例语义：成员信息与连接计数落在两个 Hash 键上，且设置了 TTL', async () => {
    const redis = new FakeRedis();
    const store = new RedisPresenceStore(redis as unknown as RedisService, 60);

    expect(await store.join(ROOM, entry(USER_A, 'A'))).toEqual({ alreadyOnline: false });
    expect([...redis.store.keys()].sort()).toEqual([
      `presence:conn:${ROOM}`,
      `presence:room:${ROOM}`,
    ]);
    expect(redis.expirations.get(`presence:room:${ROOM}`)).toBe(60);
    expect(redis.expirations.get(`presence:conn:${ROOM}`)).toBe(60);

    // 另一个实例上同一用户再连一次（模拟第二次 join）
    expect(await store.join(ROOM, entry(USER_A, 'A'))).toEqual({ alreadyOnline: true });
    expect(await store.leave(ROOM, USER_A)).toEqual({ gone: false });
    expect(await store.leave(ROOM, USER_A)).toEqual({ gone: true });
    expect(await store.list(ROOM)).toHaveLength(0);
  });
});

describe('PresenceService', () => {
  it('join/leave 维护本实例活跃房间集合（用于 TTL 续期）', async () => {
    const store = new InMemoryPresenceStore();
    const service = PresenceService.withStore(
      store,
      loadConfig({ DATABASE_URL: 'postgresql://x' }),
    );

    await service.join(ROOM, { userId: USER_A, displayName: 'A', avatarColor: '#fff' });
    expect(await service.list(ROOM)).toHaveLength(1);
    await service.join(ROOM, { userId: USER_B, displayName: 'B', avatarColor: '#000' });
    expect(await service.list(ROOM)).toHaveLength(2);

    // 续期不抛错（内存实现是空操作）
    await expect(service.touchLocalRooms()).resolves.toBeUndefined();

    expect(await service.leave(ROOM, USER_A)).toEqual({ gone: true });
    expect(await service.leave(ROOM, USER_B)).toEqual({ gone: true });
    expect(await service.list(ROOM)).toHaveLength(0);

    // 存储故障时 join/leave 不抛错（可用性优先），
    // 这里用"不在线的用户离开"模拟异常路径
    expect(await service.leave(ROOM, USER_A)).toEqual({ gone: true });
  });
});
