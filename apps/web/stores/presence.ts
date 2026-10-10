/**
 * 在线状态 store：成员头像栈 + 他人光标。
 *
 * 数据来源是 WS 的 presence:* 与 cursor:*；光标带 updatedAt，
 * `pruneCursors` 定期清掉超时条目（瞬时通道会丢包，最新的"消失"消息可能收不到）。
 */
import { create } from 'zustand';

import type { CursorInfo, PresenceMemberInfo } from '../lib/socket/board-client';

export interface PresenceState {
  /** userId → 成员信息（含自己） */
  members: Record<string, PresenceMemberInfo>;
  /** userId → 光标（世界坐标） */
  cursors: Record<string, CursorInfo>;

  setMembers: (members: PresenceMemberInfo[]) => void;
  upsertMember: (member: PresenceMemberInfo) => void;
  removeMember: (userId: string) => void;
  setCursor: (userId: string, cursor: CursorInfo) => void;
  removeCursor: (userId: string) => void;
  pruneCursors: (ttlMs: number) => void;
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>()((set) => ({
  members: {},
  cursors: {},

  setMembers(members) {
    const next: Record<string, PresenceMemberInfo> = {};
    for (const member of members) next[member.userId] = member;
    // 成员列表是权威的：不在列表里的光标一并清掉
    set((state) => {
      const cursors: Record<string, CursorInfo> = {};
      for (const userId of Object.keys(state.cursors)) {
        if (next[userId]) cursors[userId] = state.cursors[userId]!;
      }
      return { members: next, cursors };
    });
  },

  upsertMember(member) {
    set((state) => ({ members: { ...state.members, [member.userId]: member } }));
  },

  removeMember(userId) {
    set((state) => {
      const members = { ...state.members };
      delete members[userId];
      const cursors = { ...state.cursors };
      delete cursors[userId];
      return { members, cursors };
    });
  },

  setCursor(userId, cursor) {
    set((state) => ({ cursors: { ...state.cursors, [userId]: cursor } }));
  },

  removeCursor(userId) {
    set((state) => {
      if (!state.cursors[userId]) return state;
      const cursors = { ...state.cursors };
      delete cursors[userId];
      return { cursors };
    });
  },

  pruneCursors(ttlMs) {
    const now = Date.now();
    set((state) => {
      const stale = Object.entries(state.cursors).filter(([, c]) => now - c.at > ttlMs);
      if (stale.length === 0) return state;
      const cursors = { ...state.cursors };
      for (const [userId] of stale) delete cursors[userId];
      return { cursors };
    });
  },

  reset() {
    set({ members: {}, cursors: {} });
  },
}));
