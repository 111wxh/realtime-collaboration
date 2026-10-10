import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Cursor, PresenceMember } from '@collab/shared';

import { APP_CONFIG, type AppConfig } from '../../common/config';
import { RedisService } from '../../redis/redis.service';
import { InMemoryPresenceStore, type PresenceStore } from './presence.store';
import { RedisPresenceStore } from './redis-presence.store';

/** 判定"残留在线"的阈值：TTL 的 1.5 倍没活动就认为那条记录是崩溃实例留下的 */
const STALE_FACTOR = 1.5;

export interface PresenceActor {
  userId: string;
  displayName: string;
  avatarColor: string;
}

/**
 * 在线状态服务（计划书 §6.1 状态通道）：
 *  - 成员加入/离开/光标写入存储（Redis 或内存）；
 *  - 本实例服务的房间周期性续 TTL，并顺带清理残留；
 *  - 断线与崩溃走同一套出口：leave 后 gone=true 才广播 presence:left。
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private readonly store: PresenceStore;
  /** 本实例当前有连接的房间 → 本地连接数（只有 >0 的房间才需要续 TTL） */
  private readonly activeRooms = new Map<string, number>();
  private touchTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    redis: RedisService,
  ) {
    this.store = redis.enabled
      ? new RedisPresenceStore(redis, config.presenceTtlSeconds)
      : new InMemoryPresenceStore();
    if (!redis.enabled) {
      this.logger.warn('未配置 REDIS_URL：presence 退化为进程内存模式（单实例语义）');
    }
  }

  /** 便于单测直接注入替身 */
  static withStore(store: PresenceStore, config: AppConfig): PresenceService {
    const instance = Object.create(PresenceService.prototype) as PresenceService;
    Object.assign(instance, {
      config,
      store,
      activeRooms: new Map<string, number>(),
      touchTimer: null,
      logger: new Logger(PresenceService.name),
    });
    return instance;
  }

  onModuleInit(): void {
    this.touchTimer = setInterval(() => {
      void this.touchLocalRooms();
    }, this.config.presenceTouchIntervalMs);
    this.touchTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.touchTimer) clearInterval(this.touchTimer);
  }

  /** 本地连接 +1；alreadyOnline 表示该用户（可能在其他实例上）已在线，不必再广播 joined */
  async join(roomId: string, actor: PresenceActor): Promise<{ alreadyOnline: boolean }> {
    this.activeRooms.set(roomId, (this.activeRooms.get(roomId) ?? 0) + 1);
    try {
      return await this.store.join(roomId, {
        userId: actor.userId,
        displayName: actor.displayName,
        avatarColor: actor.avatarColor,
        cursor: null,
        onlineAt: new Date().toISOString(),
        lastSeenAt: Date.now(),
      });
    } catch (error) {
      this.logger.warn({ err: error, roomId }, 'presence 存储不可用，忽略本次登记');
      return { alreadyOnline: true };
    }
  }

  /** 本地连接 -1；gone=true 表示该用户在所有实例上都不在线了 */
  async leave(roomId: string, userId: string): Promise<{ gone: boolean }> {
    const local = (this.activeRooms.get(roomId) ?? 0) - 1;
    if (local > 0) this.activeRooms.set(roomId, local);
    else this.activeRooms.delete(roomId);
    try {
      return await this.store.leave(roomId, userId);
    } catch (error) {
      this.logger.warn({ err: error, roomId, userId }, 'presence 存储不可用，忽略本次注销');
      return { gone: false };
    }
  }

  async list(roomId: string): Promise<PresenceMember[]> {
    try {
      return await this.store.list(roomId);
    } catch (error) {
      this.logger.warn({ err: error, roomId }, 'presence 列表读取失败');
      return [];
    }
  }

  async setCursor(roomId: string, userId: string, cursor: Cursor | null): Promise<void> {
    try {
      await this.store.setCursor(roomId, userId, cursor);
    } catch (error) {
      this.logger.warn({ err: error, roomId }, 'presence 光标写入失败');
    }
  }

  /** 续 TTL + 清理残留；本地没有连接的房间不碰（别人的房间由别人续） */
  async touchLocalRooms(): Promise<void> {
    const roomIds = [...this.activeRooms.keys()];
    if (roomIds.length === 0) return;
    try {
      await this.store.touch(roomIds);
      const staleMs = Math.round(this.config.presenceTtlSeconds * STALE_FACTOR * 1000);
      for (const roomId of roomIds) {
        const pruned = await this.store.pruneStale(roomId, staleMs);
        if (pruned > 0) this.logger.debug({ roomId, pruned }, '清理残留在线记录');
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'presence 续期失败');
    }
  }
}
