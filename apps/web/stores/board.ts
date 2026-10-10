/**
 * 画布 store（zustand）：图形的唯一入口。
 *
 * 分工：
 *  - 同步状态（shapes / seq / pending）由 sync-core 的纯 reducer 产出，本 store 只负责落盘；
 *  - 网络副作用（发送 op、请求补齐）由 BoardClient 执行；
 *  - 撤销/重做栈放在这里：条目按"提交事务（txId）"分组，一次手势一步撤销。
 *
 * 数据流向：
 *   组件（状态机命令） → store 动作 → BoardClient.commit() → sync-core → socket
 *   socket → BoardClient → sink.dispatchSync() → sync-core → store 落盘 → 组件重绘
 */
import type { Shape, ShapePatch, ShapeStyle } from '@collab/shared';
import { create } from 'zustand';

import { newId } from '../lib/board/defaults';
import type { Tool } from '../lib/board/defaults';
import { DEFAULT_STYLE } from '../lib/board/defaults';
import type { ShapePatchIntent } from '../lib/board/interaction';
import type { Bounds, Point, ResizeHandle } from '../lib/board/hitTest';
import { getShapeBounds, hitTestHandle, hitTestTopmost, round2 } from '../lib/board/hitTest';
import { visibleShapes } from '../lib/board/layers';
import type { Viewport } from '../lib/board/renderer';
import { clampZoom, zoomAt } from '../lib/board/renderer';
import type { BoardSink, CursorInfo, PresenceMemberInfo } from '../lib/socket/board-client';
import { BoardClient } from '../lib/socket/board-client';
import { getSocketConnection } from '../lib/socket/connection';
import type { ConnectionStatus } from '../lib/socket/connection';
import type {
  AnySyncAction,
  LocalOpSpec,
  SyncEffect,
  SyncState,
  UndoOpTemplate,
} from '../lib/socket/sync-core';
import { initialSyncState, syncReduce } from '../lib/socket/sync-core';
import type { User } from '../lib/types';
import { usePresenceStore } from './presence';
import { useSessionStore } from './session';

export interface Notice {
  id: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  at: number;
}

/** 撤销栈条目：一次提交事务（一个手势 / 一次批量操作） */
export interface UndoEntry {
  txId: string;
  label: string;
  items: { clientOpId: string; inverse: UndoOpTemplate }[];
}

export interface BoardState {
  ready: boolean;
  roomId: string | null;
  boardId: string | null;
  /** 同步内核状态（shapes / seq / pending / gap） */
  sync: SyncState;
  /** 正在绘制中的本地预览（不进 shapes） */
  preview: Shape | null;
  selection: string[];
  tool: Tool;
  style: typeof DEFAULT_STYLE;
  viewport: Viewport;
  status: ConnectionStatus;
  notices: Notice[];
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  // 生命周期
  connect: (input: { roomId: string; boardId: string; user: User }) => void;
  disconnect: () => void;

  // 本地操作（走同步管道）
  createShape: (shape: Shape) => void;
  commitPatches: (patches: ShapePatchIntent[], label?: string) => void;
  deleteShapes: (ids: string[]) => void;
  applyLayerPatches: (patches: { shapeId: string; zIndex: number }[]) => void;

  // 本地预览（不走网络）
  applyPreview: (patches: ShapePatchIntent[]) => void;
  setPreview: (shape: Shape | null) => void;

  // 选择 / 工具 / 样式 / 视口
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  setTool: (tool: Tool) => void;
  setStyle: (patch: Partial<typeof DEFAULT_STYLE>) => void;
  setViewport: (viewport: Viewport) => void;
  /** 缩放（screenPoint 为锚点，缺省锚在画布左上角） */
  zoomBy: (factor: number, screenPoint?: Point) => void;
  resetViewport: () => void;

  // 光标
  sendCursor: (worldPoint: Point) => void;

  // 撤销 / 重做
  undo: () => void;
  redo: () => void;

  // 提示
  pushNotice: (level: Notice['level'], text: string) => void;
  dismissNotice: (id: string) => void;
  /** 清掉超过 maxAgeMs 的提示（组件里用 1s 的定时器驱动） */
  expireNotices: (maxAgeMs: number) => void;

  // 内部：同步内核派发入口（BoardClient 通过 sink 调用）
  dispatchSync: (action: AnySyncAction) => SyncEffect[];
  /** 命中测试辅助：取最上层图形 */
  shapeAt: (worldPoint: Point, tolerance: number) => string | null;
  boundsOf: (ids: string[]) => Bounds | null;
  handleAt: (worldPoint: Point, tolerance: number) => ResizeHandle | null;
}

/** 当前画布客户端（模块级：不进 store 状态，避免被 React 序列化/订阅） */
let client: BoardClient | null = null;

/** 监听 access token 变化的订阅（token 换了要重建 WS 握手） */
let sessionUnsub: (() => void) | null = null;

/** 撤销栈的目标：撤销产生的 op 记到 redo 栈，反之亦然 */
let undoEntryTarget: 'undo' | 'redo' = 'undo';

function pushCap<T>(list: T[], item: T, cap = 200): T[] {
  const next = [...list, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export const useBoardStore = create<BoardState>()((set, get) => {
  /** 把 patch 应用到本地视图（预览用，不改 seq / pending） */
  const applyLocalPatches = (patches: ShapePatchIntent[]) => {
    if (patches.length === 0) return;
    set((state) => {
      const shapes = { ...state.sync.shapes };
      for (const { shapeId, patch } of patches) {
        const shape = shapes[shapeId];
        if (!shape) continue;
        shapes[shapeId] = {
          ...shape,
          ...patch,
          style: patch.style ? { ...patch.style } : shape.style,
          data: patch.data ? { ...patch.data } : shape.data,
        };
      }
      return { sync: { ...state.sync, shapes } };
    });
  };

  const sink: BoardSink = {
    getSync: () => get().sync,
    dispatchSync: (action) => get().dispatchSync(action),
    setConnectionStatus: (status) => set({ status }),
    setRoomJoined: ({ boardId, members }) => {
      // boardId 以 WS 的 room:joined 为准（REST 详情里可能没有这个字段）
      set((state) => ({ boardId, ready: true, sync: { ...state.sync, boardId } }));
      usePresenceStore.getState().setMembers(members);
    },
    upsertMember: (member: PresenceMemberInfo) => usePresenceStore.getState().upsertMember(member),
    removeMember: (userId: string) => usePresenceStore.getState().removeMember(userId),
    setMembers: (members: PresenceMemberInfo[]) => usePresenceStore.getState().setMembers(members),
    setCursor: (userId: string, cursor: CursorInfo) =>
      usePresenceStore.getState().setCursor(userId, cursor),
    removeCursor: (userId: string) => usePresenceStore.getState().removeCursor(userId),
    pruneCursors: (ttlMs: number) => usePresenceStore.getState().pruneCursors(ttlMs),
    pushNotice: (level, text) => get().pushNotice(level, text),
  };

  return {
    ready: false,
    roomId: null,
    boardId: null,
    sync: initialSyncState(),
    preview: null,
    selection: [],
    tool: 'select',
    style: { ...DEFAULT_STYLE },
    viewport: { x: 0, y: 0, zoom: 1 },
    status: 'idle',
    notices: [],
    undoStack: [],
    redoStack: [],

    connect({ roomId, boardId, user }) {
      if (client) {
        client.stop();
        client = null;
      }
      const connection = getSocketConnection();
      const token = useSessionStore.getState().accessToken;
      set({
        roomId,
        boardId,
        ready: false,
        sync: initialSyncState(boardId),
        selection: [],
        preview: null,
        undoStack: [],
        redoStack: [],
        notices: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        tool: 'select',
      });
      usePresenceStore.getState().reset();
      client = new BoardClient({
        roomId,
        boardId,
        connection,
        sink,
        self: {
          userId: user.id,
          displayName: user.displayName,
          avatarColor: user.avatarColor,
        },
      });
      client.start();
      if (token) connection.connect(token);

      // token 变化（重新登录 / 刷新）→ 换个握手重连，复用同一个 client
      sessionUnsub?.();
      let lastToken = useSessionStore.getState().accessToken;
      sessionUnsub = useSessionStore.subscribe((state) => {
        if (state.accessToken && state.accessToken !== lastToken) {
          lastToken = state.accessToken;
          connection.connect(state.accessToken);
        }
      });
    },

    disconnect() {
      sessionUnsub?.();
      sessionUnsub = null;
      if (client) {
        client.stop();
        client = null;
      }
      usePresenceStore.getState().reset();
      set({ ready: false, roomId: null, boardId: null, sync: initialSyncState() });
    },

    // ---------------- 本地操作 ----------------

    createShape(shape) {
      client?.commit([{ opType: 'create', shape }], '创建图形');
    },

    commitPatches(patches, label = '修改图形') {
      if (patches.length === 0) return;
      // 提交前先把预览的最终值应用一遍，避免抬手瞬间跳回旧位置
      applyLocalPatches(patches);
      const specs: LocalOpSpec[] = [];
      for (const { shapeId, patch } of patches) {
        const shape = get().sync.shapes[shapeId];
        if (!shape) continue;
        const normalized = normalizePatch(patch);
        if (!normalized) continue; // patch 为空（没有实际变化）就跳过，协议不允许空 patch
        specs.push({ opType: 'update', shapeId, patch: normalized });
      }
      if (specs.length === 0) return;
      client?.commit(specs, label);
    },

    deleteShapes(ids) {
      const specs: LocalOpSpec[] = ids
        .filter((id) => get().sync.shapes[id])
        .map((id) => ({ opType: 'delete', shapeId: id }));
      if (specs.length === 0) return;
      client?.commit(specs, '删除图形');
      set((state) => ({ selection: state.selection.filter((id) => !ids.includes(id)) }));
    },

    applyLayerPatches(patches) {
      if (patches.length === 0) return;
      const specs: LocalOpSpec[] = patches.map(({ shapeId, zIndex }) => ({
        opType: 'reorder',
        shapeId,
        zIndex,
      }));
      client?.commit(specs, '调整层级');
    },

    // ---------------- 预览 ----------------

    applyPreview(patches) {
      applyLocalPatches(patches);
    },

    setPreview(shape) {
      set({ preview: shape });
    },

    // ---------------- 选择 / 工具 / 样式 ----------------

    setSelection(ids) {
      set({ selection: ids });
    },

    toggleSelection(id) {
      set((state) => ({
        selection: state.selection.includes(id)
          ? state.selection.filter((item) => item !== id)
          : [...state.selection, id],
      }));
    },

    setTool(tool) {
      set({ tool });
      if (tool !== 'select') set({ selection: [] });
    },

    setStyle(patch) {
      const style = { ...get().style, ...patch };
      // 样式变更同时作用于：后续新图形的默认值 + 当前选中集（立即提交）
      const selection = get().selection;
      const selected = selection
        .map((id) => get().sync.shapes[id])
        .filter((shape): shape is Shape => !!shape && !shape.deletedAt);
      if (selected.length > 0) {
        const specs: LocalOpSpec[] = [];
        for (const shape of selected) {
          const nextStyle: ShapeStyle = { ...shape.style };
          if (patch.stroke !== undefined) nextStyle.stroke = patch.stroke;
          if (patch.strokeWidth !== undefined) nextStyle.strokeWidth = patch.strokeWidth;
          // 填充只对有面积的图元有意义
          if (patch.fill !== undefined && (shape.type === 'rect' || shape.type === 'ellipse')) {
            nextStyle.fill = patch.fill;
          }
          specs.push({ opType: 'update', shapeId: shape.id, patch: { style: nextStyle } });
        }
        client?.commit(specs, '修改样式');
      }
      set({ style });
    },

    // ---------------- 视口 ----------------

    setViewport(viewport) {
      set({ viewport: { ...viewport, zoom: clampZoom(viewport.zoom) } });
    },

    zoomBy(factor, screenPoint) {
      set((state) => {
        const point = screenPoint ?? { x: 0, y: 0 };
        return { viewport: zoomAt(state.viewport, point, state.viewport.zoom * factor) };
      });
    },

    resetViewport() {
      set({ viewport: { x: 0, y: 0, zoom: 1 } });
    },

    // ---------------- 光标 ----------------

    sendCursor(worldPoint) {
      client?.sendCursor(round2(worldPoint.x), round2(worldPoint.y), get().tool);
    },

    // ---------------- 撤销 / 重做 ----------------

    undo() {
      const entry = get().undoStack[get().undoStack.length - 1];
      if (!entry) return;
      set((state) => ({
        undoStack: state.undoStack.slice(0, -1),
        redoStack: pushCap(state.redoStack, entry),
      }));
      undoEntryTarget = 'redo';
      client?.applyUndoInverses(entry.items.map((item) => item.inverse));
      // dispatchSync 是同步的：撤销产生的 op 已经归到 redo 栈，这里立刻复位，
      // 避免"逆操作全被过滤掉（没有产生任何 op）"时把下一个用户操作误判成撤销流
      undoEntryTarget = 'undo';
    },

    redo() {
      const entry = get().redoStack[get().redoStack.length - 1];
      if (!entry) return;
      set((state) => ({
        redoStack: state.redoStack.slice(0, -1),
        undoStack: pushCap(state.undoStack, entry),
      }));
      undoEntryTarget = 'undo';
      client?.applyUndoInverses(entry.items.map((item) => item.inverse));
      undoEntryTarget = 'undo';
    },

    // ---------------- 提示 ----------------

    pushNotice(level, text) {
      set((state) => ({
        notices: pushCap(state.notices, { id: newId(), level, text, at: Date.now() }, 5),
      }));
    },

    dismissNotice(id) {
      set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
    },

    expireNotices(maxAgeMs) {
      const now = Date.now();
      set((state) => {
        const kept = state.notices.filter((notice) => now - notice.at < maxAgeMs);
        return kept.length === state.notices.length ? state : { notices: kept };
      });
    },

    // ---------------- 同步内核入口 ----------------

    dispatchSync(action) {
      const { state, effects } = syncReduce(get().sync, action);
      // 副作用里与 UI 直接相关的部分就地消费，其余（send / sync）交给 BoardClient 执行 IO
      const ioEffects: SyncEffect[] = [];
      let undoStack = get().undoStack;
      let redoStack = get().redoStack;

      for (const effect of effects) {
        switch (effect.kind) {
          case 'undo-entry': {
            const entry: UndoEntry = {
              txId: effect.entry.txId,
              label: effect.entry.label,
              items: effect.entry.items,
            };
            if (undoEntryTarget === 'redo') {
              redoStack = upsertUndoEntry(redoStack, entry);
            } else {
              undoStack = upsertUndoEntry(undoStack, entry);
            }
            break;
          }
          case 'undo-discard': {
            undoStack = removeUndoItem(undoStack, effect.txId, effect.clientOpId);
            redoStack = removeUndoItem(redoStack, effect.txId, effect.clientOpId);
            break;
          }
          case 'undo-replace': {
            undoStack = replaceUndoItem(undoStack, effect.txId, effect.fromClientOpId, effect.item);
            redoStack = replaceUndoItem(redoStack, effect.txId, effect.fromClientOpId, effect.item);
            break;
          }
          case 'notice':
            get().pushNotice(effect.level, effect.text);
            break;
          default:
            ioEffects.push(effect);
            break;
        }
      }

      // 用户的新操作要清空重做栈（标准编辑器行为）；撤销/重做自身不清
      const isUndoFlow = action.kind === 'local-ops' && undoEntryTarget === 'redo';
      if (action.kind === 'local-ops' && !isUndoFlow && redoStack.length > 0) {
        redoStack = [];
      }
      undoEntryTarget = 'undo';

      set({ sync: state, undoStack, redoStack });
      return ioEffects;
    },

    // ---------------- 命中测试辅助 ----------------

    shapeAt(worldPoint, tolerance) {
      const hit = hitTestTopmost(visibleShapes(get().sync.shapes), worldPoint, tolerance);
      return hit ? hit.shapeId : null;
    },

    boundsOf(ids) {
      const bounds: Bounds[] = [];
      for (const id of ids) {
        const shape = get().sync.shapes[id];
        if (shape && !shape.deletedAt) bounds.push(getShapeBounds(shape));
      }
      return unionOf(bounds);
    },

    handleAt(worldPoint, tolerance) {
      const selection = get().selection;
      if (selection.length !== 1) return null;
      const shape = get().sync.shapes[selection[0]!];
      if (!shape || shape.deletedAt) return null;
      return hitTestHandle(getShapeBounds(shape), worldPoint, tolerance);
    },
  };
});

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function unionOf(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of list) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 归一化 patch：只保留有值的字段（协议里 patch 不允许是空对象） */
function normalizePatch(patch: ShapePatch): ShapePatch | null {
  const out: ShapePatch = {};
  if (patch.x !== undefined) out.x = patch.x;
  if (patch.y !== undefined) out.y = patch.y;
  if (patch.w !== undefined) out.w = patch.w;
  if (patch.h !== undefined) out.h = patch.h;
  if (patch.rotation !== undefined) out.rotation = patch.rotation;
  if (patch.zIndex !== undefined) out.zIndex = patch.zIndex;
  if (patch.style !== undefined) out.style = patch.style;
  if (patch.data !== undefined) out.data = patch.data;
  return Object.keys(out).length > 0 ? out : null;
}

function upsertUndoEntry(stack: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  const index = stack.findIndex((item) => item.txId === entry.txId);
  if (index < 0) return pushCap(stack, entry);
  // 同一个 tx 的多个 op：合并到同一条撤销条目（items 里按 clientOpId 去重）
  const existing = stack[index]!;
  const items = [...existing.items];
  for (const item of entry.items) {
    if (!items.some((known) => known.clientOpId === item.clientOpId)) items.push(item);
  }
  const next = [...stack];
  next[index] = { ...existing, items };
  return next;
}

function removeUndoItem(stack: UndoEntry[], txId: string, clientOpId: string): UndoEntry[] {
  const index = stack.findIndex((item) => item.txId === txId);
  if (index < 0) return stack;
  const entry = stack[index]!;
  const items = entry.items.filter((item) => item.clientOpId !== clientOpId);
  if (items.length === 0) return stack.filter((_, i) => i !== index);
  const next = [...stack];
  next[index] = { ...entry, items };
  return next;
}

function replaceUndoItem(
  stack: UndoEntry[],
  txId: string,
  fromClientOpId: string,
  item: UndoEntry['items'][number],
): UndoEntry[] {
  const index = stack.findIndex((entry) => entry.txId === txId);
  if (index < 0) return stack;
  const entry = stack[index]!;
  const next = [...stack];
  next[index] = {
    ...entry,
    items: entry.items.map((known) =>
      known.clientOpId === fromClientOpId ? { ...item, inverse: item.inverse } : known,
    ),
  };
  return next;
}
