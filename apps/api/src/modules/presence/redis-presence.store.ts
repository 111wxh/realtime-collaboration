import { Logger } from '@nestjs/common';
import type { Cursor, PresenceMember } from '@collab/shared';

import { RedisService } from '../../redis/redis.service';
import {
  parseEntry,
  toPresenceMember,
  type PresenceEntry,
  type PresenceStore,
} from './presence.store';

/**
 * Redis Hash 版 presence（计划书 §7.3 / §5 的"热数据走 Redis"）。
 *
 * 键设计：
 *   presence:room:<roomId>   Hash：userId → PresenceEntry JSON（成员信息 + 光标）
 *   presence:conn:<roomId>   Hash：userId → 连接数（支持同一用户多标签页/多实例）
 *
 * 为什么连接数单独一个 Hash：HINCRBY 是原子的，多实例同时进出同一用户也不会把
 * 计数算错；而成员信息只需要"最后一个写者覆盖"，不需要 CAS。
 * 两个键都设 TTL，由持有该房间连接的实例周期续期——实例崩溃后残留的在线状态
 * 会在 TTL 内自动消失，配合 pruneStale 清掉慢路径上的残留字段。
 */
export class RedisPresenceStore implements PresenceStore {
  private static readonly MEMBER_PREFIX = 'presence:room:';
  private static readonly CONN_PREFIX = 'presence:conn:';

  constructor(
    private readonly redis: RedisService,
    private readonly ttlSeconds: number,
    private readonly logger: Logger = new Logger(RedisPresenceStore.name),
  ) {}

  private memberKey(roomId: string): string {
    return RedisPresenceStore.MEMBER_PREFIX + roomId;
  }

  private connKey(roomId: string): string {
    return RedisPresenceStore.CONN_PREFIX + roomId;
  }

  async join(roomId: string, entry: PresenceEntry): Promise<{ alreadyOnline: boolean }> {
    try {
      const memberKey = this.memberKey(roomId);
      const connKey = this.connKey(roomId);
      await this.redis.hset(memberKey, { [entry.userId]: JSON.stringify(entry) });
      const connections = await this.redis.hincrby(connKey, entry.userId, 1);
      await Promise.all([
        this.redis.expire(memberKey, this.ttlSeconds),
        this.redis.expire(connKey, this.ttlSeconds),
      ]);
      return { alreadyOnline: connections > 1 };
    } catch (error) {
      this.logger.warn({ err: error, roomId }, 'presence:join 失败'); // 降级由上层处理
      throw error;
    }
  }

  async leave(roomId: string, userId: string): Promise<{ gone: boolean }> {
    const memberKey = this.memberKey(roomId);
    const connKey = this.connKey(roomId);
    const connections = await this.redis.hincrby(connKey, userId, -1);
    if (connections > 0) return { gone: false };
    await this.redis.hdel(memberKey, userId);
    await this.redis.hdel(connKey, userId);
    return { gone: true };
  }

  async list(roomId: string): Promise<PresenceMember[]> {
    const map = await this.redis.hgetall(this.memberKey(roomId));
    const members: PresenceMember[] = [];
    for (const raw of Object.values(map)) {
      const entry = parseEntry(raw);
      if (entry) members.push(toPresenceMember(entry));
    }
    return members;
  }

  async setCursor(roomId: string, userId: string, cursor: Cursor | null): Promise<void> {
    const memberKey = this.memberKey(roomId);
    const raw = await this.redis.hget(memberKey, userId);
    const entry = parseEntry(raw);
    if (!entry) return;
    entry.cursor = cursor;
    entry.lastSeenAt = Date.now();
    await this.redis.hset(memberKey, { [userId]: JSON.stringify(entry) });
  }

  async touch(roomIds: string[]): Promise<void> {
    await Promise.all(
      roomIds.flatMap((roomId) => [
        this.redis.expire(this.memberKey(roomId), this.ttlSeconds).catch(() => 0),
        this.redis.expire(this.connKey(roomId), this.ttlSeconds).catch(() => 0),
      ]),
    );
  }

  async pruneStale(roomId: string, olderThanMs: number): Promise<number> {
    const memberKey = this.memberKey(roomId);
    const map = await this.redis.hgetall(memberKey);
    const deadline = Date.now() - olderThanMs;
    const stale: string[] = [];
    for (const [userId, raw] of Object.entries(map)) {
      const entry = parseEntry(raw);
      if (!entry || entry.lastSeenAt < deadline) stale.push(userId);
    }
    if (stale.length === 0) return 0;
    await this.redis.hdel(memberKey, ...stale);
    await this.redis.hdel(this.connKey(roomId), ...stale);
    return stale.length;
  }
}
