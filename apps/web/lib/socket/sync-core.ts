/**
 * 同步内核（本项目的核心逻辑）：纯函数 reducer，零 DOM / 零 socket 依赖，可直接单测。
 *
 * 它负责计划书 §6.5 的六条一致性规则在前端的落实：
 *  1. 幂等      —— 一切本地写操作带 clientOpId，重发不会产生重复图形；
 *  2. 乐观更新  —— 本地操作立刻改本地视图（标记 pending），ack 后转正；
 *  3. 回滚      —— shape:rejected 时按逆操作回滚；VERSION_CONFLICT 带 serverShape 时
 *                  以 serverShape 为新基底重放 patch（有次数上限）；
 *  4. seq 对齐  —— 广播 seq 与期望不连续时：先收进乱序缓冲（不丢弃消息）+ 立刻 board:sync 补齐，
 *                  补齐后按 seq 升序重放，重复 seq 幂等丢弃；
 *  5. 陈旧快照  —— board:state 的 seq 小于本地 seq 直接丢弃；
 *  6. 断线队列  —— 未 ack 的操作留在 pending 队列，重连后按序补发；队列超过上限时
 *                  合并为"每个图形只发最终态"（降级而不是无限堆积）。
 *
 * 状态流转图：
 *
 *   local-ops ──> pending(queued) ──sent──> pending(sent) ──ack──> 从 pending 移除 + serverShape 落盘
 *                                                      └─reject─> 回滚 / 重放（新 clientOpId）
 *   authority(seq) ──> seq == expected  → 立即应用
 *                  └─ seq >  expected  → 应用 + 缓冲 + 请求 board:sync
 *   board:ops ──> 按 seq 升序幂等重放 → 推进 seq → 尝试清空乱序缓冲
 *   board:state ──> seq < 本地 → 丢弃；否则整体替换 + 重放 pending 覆盖层（保住乐观视图）
 */
import type { ErrorCode, Shape, ShapeOp, ShapePatch, ServerPayload } from '@collab/shared';
import { ERROR_CODES, SERVER_EVENTS } from '@collab/shared';

import { newId } from '../board/defaults';

/** pending 队列上限：超过后降级为"仅发最终态"（计划书 §7.4 背压） */
export const MAX_PENDING = 500;
/** VERSION_CONFLICT 的重放上限，超过就放弃这次操作并提示用户 */
export const MAX_VERSION_RETRY = 3;
/** 单次 shape:batch 的最大 op 数（协议 schema 上限 200，留出余量） */
export const MAX_BATCH = 100;

export type AckPayload = ServerPayload<typeof SERVER_EVENTS.SHAPE_ACK>;
export type RejectedPayload = ServerPayload<typeof SERVER_EVENTS.SHAPE_REJECTED>;
export type BoardStatePayload = ServerPayload<typeof SERVER_EVENTS.BOARD_STATE>;
export type BoardOpsPayload = ServerPayload<typeof SERVER_EVENTS.BOARD_OPS>;

/** 撤销用的逆操作模板：不带 clientOpId / seq，真正发送时再补 */
export type UndoOpTemplate = Pick<ShapeOp, 'opType' | 'shapeId' | 'shape' | 'patch' | 'zIndex'>;

/** 本地操作意图：由 store / 状态机产出，内核负责补 clientOpId 与 baseVersion */
export type LocalOpSpec =
  | { opType: 'create'; shape: Shape }
  | { opType: 'update'; shapeId: string; patch: ShapePatch }
  | { opType: 'delete'; shapeId: string }
  | { opType: 'restore'; shape: Shape }
  | { opType: 'reorder'; shapeId: string; zIndex: number };

export interface PendingOp {
  clientOpId: string;
  /** 撤销分组：一次手势（如多选拖动）产生的多个 op 共享一个 txId */
  txId: string;
  op: ShapeOp;
  /** update 类操作发送时用的 baseVersion（乐观并发控制的基底） */
  baseVersion?: number;
  /** queued：还没发出去（断线 / 降级）；sent：已发出等待 ack */
  status: 'queued' | 'sent';
  /** 重放次数（VERSION_CONFLICT 时 +1） */
  attempts: number;
  /** 本地应用时算出的逆操作，供撤销栈使用 */
  inverse: UndoOpTemplate;
}

export interface SyncStats {
  /** 已应用的权威 op 数 */
  applied: number;
  acked: number;
  rejected: number;
  /** 因 seq 断档触发的补齐次数 */
  resyncs: number;
  /** 因队列超限被合并/丢弃的操作数 */
  degraded: number;
}

export interface SyncState {
  boardId: string | null;
  /** 已连续应用的权威 seq（0 表示还没有任何权威状态） */
  seq: number;
  /** 本地视图（乐观层叠加在权威状态之上） */
  shapes: Record<string, Shape>;
  /** 未 ack 的本地操作，按产生顺序排列 */
  pending: PendingOp[];
  /** 乱序缓冲：seq → op（收到但还接不上的权威 op） */
  gap: Record<number, ShapeOp>;
  /** 已经发出 board:sync 但 seq 还没推进（避免重复请求打爆服务端） */
  awaitingSync: boolean;
  stats: SyncStats;
}

/** 一次"提交事务"的撤销记录（内核产出，store 负责入栈） */
export interface UndoEntryDraft {
  txId: string;
  label: string;
  items: { clientOpId: string; inverse: UndoOpTemplate }[];
}

export type SyncEffect =
  /** 待发送的本地 op（manager 负责打包成单事件或 shape:batch） */
  | { kind: 'send'; ops: ShapeOp[] }
  /** 检漏：请求 sinceSeq 之后的增量 */
  | { kind: 'sync'; sinceSeq: number }
  /** 新事务入撤销栈 */
  | { kind: 'undo-entry'; entry: UndoEntryDraft }
  /** 某个 op 被拒：把它从撤销条目里摘掉（全空则整条移除） */
  | { kind: 'undo-discard'; txId: string; clientOpId: string }
  /** 重放后代次替换条目里的 clientOpId 与逆操作 */
  | {
      kind: 'undo-replace';
      txId: string;
      fromClientOpId: string;
      item: UndoEntryDraft['items'][number];
    }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export interface SyncAction {
  kind: 'reset';
  boardId: string;
}
export interface LocalOpsAction {
  kind: 'local-ops';
  ops: LocalOpSpec[];
  txId: string;
  label: string;
}
export interface ConnectedAction {
  kind: 'connected';
}
export interface SentAction {
  kind: 'sent';
  clientOpIds: string[];
}
export interface AckAction {
  kind: 'ack';
  payload: AckPayload;
}
export interface RejectAction {
  kind: 'reject';
  payload: RejectedPayload;
}
export interface AuthorityAction {
  kind: 'authority';
  seq: number;
  op: ShapeOp;
}
export interface BoardStateAction {
  kind: 'board-state';
  payload: BoardStatePayload;
}
export interface BoardOpsAction {
  kind: 'board-ops';
  payload: BoardOpsPayload;
}

export type AnySyncAction =
  | SyncAction
  | LocalOpsAction
  | ConnectedAction
  | SentAction
  | AckAction
  | RejectAction
  | AuthorityAction
  | BoardStateAction
  | BoardOpsAction;

export interface SyncResult {
  state: SyncState;
  effects: SyncEffect[];
}

// ---------------------------------------------------------------------------
// 初始状态
// ---------------------------------------------------------------------------

export function initialSyncState(boardId: string | null = null): SyncState {
  return {
    boardId,
    seq: 0,
    shapes: {},
    pending: [],
    gap: {},
    awaitingSync: false,
    stats: { applied: 0, acked: 0, rejected: 0, resyncs: 0, degraded: 0 },
  };
}

// ---------------------------------------------------------------------------
// op 应用（乐观与权威共用同一份实现）
// ---------------------------------------------------------------------------

function cloneShape(shape: Shape): Shape {
  return {
    ...shape,
    style: { ...shape.style },
    data: { ...shape.data, points: shape.data.points?.map((p) => ({ ...p })) },
  };
}

/** update patch 的逆：patch 里出现的字段回填旧值（样式/数据是整体替换） */
function invertPatch(previous: Shape, patch: ShapePatch): ShapePatch | null {
  const inverse: ShapePatch = {};
  if (patch.x !== undefined) inverse.x = previous.x;
  if (patch.y !== undefined) inverse.y = previous.y;
  if (patch.w !== undefined) inverse.w = previous.w;
  if (patch.h !== undefined) inverse.h = previous.h;
  if (patch.rotation !== undefined) inverse.rotation = previous.rotation;
  if (patch.zIndex !== undefined) inverse.zIndex = previous.zIndex;
  if (patch.style !== undefined) inverse.style = { ...previous.style };
  if (patch.data !== undefined) inverse.data = { ...previous.data };
  return Object.keys(inverse).length > 0 ? inverse : null;
}

/**
 * 把一条 op 应用到本地视图，顺带算出它的逆操作（撤销用）。
 *
 * 注意：乐观应用不改 `version` —— 本地视图里的 version 始终是"最后一次服务端确认"的值，
 * 这样后续 op 的 baseVersion 才有意义（服务端拿它做乐观并发控制）。
 */
export function applyOp(
  shapes: Record<string, Shape>,
  op: ShapeOp,
): { shapes: Record<string, Shape>; inverse: UndoOpTemplate | null } {
  const next = { ...shapes };
  const previous = op.shapeId ? shapes[op.shapeId] : undefined;
  switch (op.opType) {
    case 'create':
    case 'restore': {
      const incoming = op.shape;
      if (!incoming) return { shapes, inverse: null };
      next[op.shapeId] = cloneShape(incoming);
      // create 与 restore 的逆都是软删除
      return { shapes: next, inverse: { opType: 'delete', shapeId: op.shapeId } };
    }
    case 'update': {
      if (!previous || !op.patch) return { shapes, inverse: null };
      const inversePatch = invertPatch(previous, op.patch);
      const patched: Shape = {
        ...previous,
        ...op.patch,
        style: op.patch.style ? { ...op.patch.style } : previous.style,
        data: op.patch.data ? { ...op.patch.data } : previous.data,
      };
      next[op.shapeId] = patched;
      return {
        shapes: next,
        inverse: inversePatch
          ? { opType: 'update', shapeId: op.shapeId, patch: inversePatch }
          : null,
      };
    }
    case 'delete': {
      if (!previous) return { shapes, inverse: null };
      next[op.shapeId] = { ...previous, deletedAt: new Date().toISOString() };
      return {
        shapes: next,
        inverse: { opType: 'restore', shapeId: op.shapeId, shape: cloneShape(previous) },
      };
    }
    case 'reorder': {
      if (!previous || op.zIndex === undefined) return { shapes, inverse: null };
      next[op.shapeId] = { ...previous, zIndex: op.zIndex };
      return {
        shapes: next,
        inverse: { opType: 'update', shapeId: op.shapeId, patch: { zIndex: previous.zIndex } },
      };
    }
    default:
      return { shapes, inverse: null };
  }
}

/**
 * 依次应用多条 op，返回每一步的逆操作（撤销栈 / 批量重放用）。
 * 单条应用走 applyOp；这里只是把它串起来，语义完全一致。
 */
export function applyOps(
  shapes: Record<string, Shape>,
  ops: ShapeOp[],
): { shapes: Record<string, Shape>; inverses: (UndoOpTemplate | null)[] } {
  let current = shapes;
  const inverses: (UndoOpTemplate | null)[] = [];
  for (const op of ops) {
    const result = applyOp(current, op);
    current = result.shapes;
    inverses.push(result.inverse);
  }
  return { shapes: current, inverses };
}

// ---------------------------------------------------------------------------
// 本地 op 的构造与入队
// ---------------------------------------------------------------------------

/** 本地操作意图 → 线上 op（补 clientOpId；update 顺带取出 baseVersion） */
function specToOp(
  spec: LocalOpSpec,
  shapes: Record<string, Shape>,
): { op: ShapeOp; baseVersion?: number } | null {
  switch (spec.opType) {
    case 'create':
      return {
        op: {
          opType: 'create',
          shapeId: spec.shape.id,
          shape: cloneShape(spec.shape),
          clientOpId: newId(),
        },
      };
    case 'restore':
      return {
        op: {
          opType: 'restore',
          shapeId: spec.shape.id,
          shape: cloneShape(spec.shape),
          clientOpId: newId(),
        },
      };
    case 'update': {
      const base = shapes[spec.shapeId];
      return {
        op: {
          opType: 'update',
          shapeId: spec.shapeId,
          patch: { ...spec.patch },
          clientOpId: newId(),
        },
        baseVersion: base?.version,
      };
    }
    case 'delete':
      return { op: { opType: 'delete', shapeId: spec.shapeId, clientOpId: newId() } };
    case 'reorder':
      return {
        op: {
          opType: 'reorder',
          shapeId: spec.shapeId,
          zIndex: spec.zIndex,
          patch: { zIndex: spec.zIndex },
          clientOpId: newId(),
        },
      };
    default:
      return null;
  }
}

/**
 * 队列降级：把同一个图形上还没发出去的旧 op 合并进新 op，只保留最终态。
 *
 * 正确性依据：op 都是"绝对值"语义（patch 里是目标值，不是增量），
 * 所以新 op 直接覆盖旧 op 的效果；合并时要把旧 op 改过的字段并进新 op 的 patch，
 * 否则服务端会漏掉那些字段的修改。
 */
export function coalesceOps(older: ShapeOp, newer: ShapeOp): ShapeOp | null {
  if (older.shapeId !== newer.shapeId) return null;
  if (newer.opType === 'delete') return newer; // 删除是终态
  if (newer.opType === 'create' && newer.shape) return newer; // 创建即最终态
  if (newer.opType === 'restore' && newer.shape) return newer;

  if (newer.opType === 'update') {
    if (older.opType === 'create' && older.shape) {
      // create + update → create（带最终几何）
      return { ...older, shape: { ...older.shape, ...newer.patch } };
    }
    if (older.opType === 'update' && older.patch) {
      return { ...newer, patch: { ...older.patch, ...newer.patch } };
    }
    if (older.opType === 'reorder' && older.zIndex !== undefined) {
      return { ...newer, patch: { zIndex: older.zIndex, ...newer.patch } };
    }
    return newer;
  }

  if (newer.opType === 'reorder') {
    if (older.opType === 'create' && older.shape) {
      return { ...older, shape: { ...older.shape, zIndex: newer.zIndex ?? older.shape.zIndex } };
    }
    if (older.opType === 'update' && older.patch) {
      return { ...newer, patch: { ...older.patch, zIndex: newer.zIndex } };
    }
    return newer;
  }

  return newer;
}

/** 入队：应用乐观效果 + 生成 pending 记录 + 必要时的队列降级 */
function enqueue(
  state: SyncState,
  spec: LocalOpSpec,
  txId: string,
  label: string,
  effects: SyncEffect[],
): SyncState {
  const built = specToOp(spec, state.shapes);
  if (!built) return state;
  const applied = applyOp(state.shapes, built.op);
  if (!applied.inverse) {
    // 逆操作算不出来说明基底缺失（图形不存在）——放弃这次本地操作
    effects.push({ kind: 'notice', level: 'warn', text: '目标图形已不存在，操作未提交' });
    return state;
  }

  let pending = state.pending;
  let stats = state.stats;
  let op = built.op;
  let inverse = applied.inverse;

  if (pending.length >= MAX_PENDING) {
    // 降级：把该图形所有"还没发出去"的 op 折叠成当前这一条（只发最终态）
    const unsent = pending.filter((p) => p.status === 'queued' && p.op.shapeId === op.shapeId);
    if (unsent.length > 0) {
      // 折叠方向：从"最新"往"最旧"合，累积值永远优先 —— 保证每个字段留下的是最新值；
      // 反向（最旧优先）会让一条老的 create 把之后所有 update 的字段吃掉。
      op = [...unsent]
        .reverse()
        .reduce((merged, item) => coalesceOps(item.op, merged) ?? merged, op);
      const removedIds = new Set(unsent.map((p) => p.clientOpId));
      pending = pending.filter((p) => !removedIds.has(p.clientOpId));
      stats = { ...stats, degraded: stats.degraded + unsent.length };
      effects.push({
        kind: 'notice',
        level: 'warn',
        text: '网络较慢，已合并积压操作，只提交每个图形的最终状态',
      });
    } else {
      // 同一图形没有可合并的：丢掉最老的一条 queued，保证队列不无限增长
      const droppedIndex = pending.findIndex((p) => p.status === 'queued');
      if (droppedIndex >= 0) {
        pending = pending.filter((_, index) => index !== droppedIndex);
        stats = { ...stats, degraded: stats.degraded + 1 };
        effects.push({
          kind: 'notice',
          level: 'warn',
          text: '操作队列已满，最早的未发送操作被丢弃',
        });
      }
    }
  }

  const entry: PendingOp = {
    clientOpId: op.clientOpId,
    txId,
    op,
    baseVersion: built.baseVersion,
    status: 'queued',
    attempts: 0,
    inverse,
  };
  effects.push({ kind: 'send', ops: [entry.op] });
  effects.push({
    kind: 'undo-entry',
    entry: { txId, label, items: [{ clientOpId: entry.clientOpId, inverse }] },
  });

  return { ...state, shapes: applied.shapes, pending: [...pending, entry], stats };
}

/** 把 pending 里的乐观效果重新叠到（新的）权威状态之上 */
export function reapplyPending(state: SyncState): Record<string, Shape> {
  let shapes = state.shapes;
  for (const item of state.pending) {
    shapes = applyOp(shapes, item.op).shapes;
  }
  return shapes;
}

// ---------------------------------------------------------------------------
// 权威消息
// ---------------------------------------------------------------------------

/** 按 seq 顺序应用缓冲里的 op，直到接不上为止 */
function drainGap(state: SyncState, effects: SyncEffect[]): SyncState {
  if (Object.keys(state.gap).length === 0) return state;
  let seq = state.seq;
  let shapes = state.shapes;
  const gap = { ...state.gap };
  while (gap[seq + 1]) {
    const op = gap[seq + 1]!;
    shapes = applyOp(shapes, op).shapes;
    delete gap[seq + 1];
    seq += 1;
  }
  return {
    ...state,
    seq,
    shapes,
    gap,
    awaitingSync: Object.keys(gap).length === 0 ? false : state.awaitingSync,
    stats: { ...state.stats, applied: state.stats.applied + Math.max(0, seq - state.seq) },
  };
}

/** 请求补齐（同一个缺口只发一次，等 seq 推进后再允许下一次） */
function requestSync(state: SyncState, effects: SyncEffect[]): SyncState {
  if (state.awaitingSync && Object.keys(state.gap).length < 50) return state;
  effects.push({ kind: 'sync', sinceSeq: state.seq });
  return {
    ...state,
    awaitingSync: true,
    stats: { ...state.stats, resyncs: state.stats.resyncs + 1 },
  };
}

function onAuthority(state: SyncState, seq: number, op: ShapeOp, effects: SyncEffect[]): SyncState {
  if (seq <= state.seq) {
    // 幂等：重复/迟到的广播直接丢（不算失败）
    return state;
  }
  // 广播 op 自带 seq（协议里 ShapeOp.seq 是可选的，这里补上便于缓冲重放）
  const opWithSeq: ShapeOp = op.seq === seq ? op : { ...op, seq };
  const applied = applyOp(state.shapes, opWithSeq);
  let next: SyncState = {
    ...state,
    shapes: applied.shapes,
    stats: { ...state.stats, applied: state.stats.applied + 1 },
  };

  if (seq === state.seq + 1) {
    next = { ...next, seq, awaitingSync: false };
    return drainGap(next, effects);
  }

  // seq > expected：不丢弃这条消息（先应用 + 缓冲），同时立刻请求补齐
  next = { ...next, gap: { ...state.gap, [seq]: opWithSeq } };
  next = requestSync(next, effects);
  return next;
}

function onBoardState(
  state: SyncState,
  payload: BoardStatePayload,
  effects: SyncEffect[],
): SyncState {
  if (state.seq > 0 && payload.seq < state.seq) {
    // 陈旧快照：丢弃，避免状态回退
    effects.push({ kind: 'notice', level: 'info', text: '已忽略过期的画布快照' });
    return state;
  }
  const shapes: Record<string, Shape> = {};
  for (const shape of payload.shapes) {
    shapes[shape.id] = cloneShape(shape);
  }
  // 快照落地后把 pending 的乐观覆盖层重新叠上去，避免"自己的操作看起来被回滚"
  const withPending = reapplyPending({ ...state, shapes });
  const next: SyncState = {
    ...state,
    seq: payload.seq,
    shapes: withPending,
    awaitingSync: false,
    // 快照已经覆盖到 payload.seq，比它旧的缓冲没有意义
    gap: Object.fromEntries(Object.entries(state.gap).filter(([key]) => Number(key) > payload.seq)),
  };
  return drainGap(next, effects);
}

function onBoardOps(state: SyncState, payload: BoardOpsPayload, effects: SyncEffect[]): SyncState {
  let shapes = state.shapes;
  let seq = state.seq;
  let appliedCount = 0;
  const ops = [...payload.ops].sort((a, b) => {
    const left = a.seq ?? 0;
    const right = b.seq ?? 0;
    return left - right;
  });

  ops.forEach((raw, index) => {
    // 服务端没带 seq 时按 fromSeq 推导，保证"逐条对齐"
    const opSeq = raw.seq ?? payload.fromSeq + index;
    if (opSeq <= seq) return; // 幂等：重复的 op 直接跳过
    if (opSeq !== seq + 1) {
      // 增量里自己还有洞：先缓冲，稍后再补
      return;
    }
    const op: ShapeOp = raw.seq === opSeq ? raw : { ...raw, seq: opSeq };
    shapes = applyOp(shapes, op).shapes;
    seq = opSeq;
    appliedCount += 1;
  });

  // 还没对齐到 latestSeq → 说明仍有缺口；同时把缓冲里已经能接上的部分重放掉
  let next: SyncState = {
    ...state,
    shapes,
    seq,
    awaitingSync: false,
    stats: { ...state.stats, applied: state.stats.applied + appliedCount },
  };
  next = drainGap(next, effects);
  if (next.seq < payload.latestSeq) {
    next = requestSync(next, effects);
  }
  return next;
}

// ---------------------------------------------------------------------------
// ack / reject
// ---------------------------------------------------------------------------

function onAck(state: SyncState, payload: AckPayload, effects: SyncEffect[]): SyncState {
  // 1) ack 也是一次权威信号：服务端广播不回发给自己（回音抑制），
  //    所以用 ack 携带的 seq 推进本地序号 —— 但绝不越过空洞（越过会永久漏掉别人的 op）。
  const aligned = alignFromAck(state, payload, effects);

  /**
   * 2) 摘掉已确认的 pending。
   *
   * 服务端的 ack 有两种形状（见 apps/api 的 realtime.gateway）：
   *  - 单条写：clientOpId + 可选 seq + serverShape；
   *  - shape:batch：clientOpId 只带"第一条 op"的 id，逐条确认结果在 seqs（key = clientOpId）。
   *    所以这里必须把 seqs 里的每个 clientOpId 都摘掉，否则批量操作会一直挂在 pending 里
   *    （只在重连时被重复补发，虽然幂等但白白增加流量）。
   */
  const confirmedIds = new Set<string>([payload.clientOpId]);
  if (payload.seqs) {
    for (const clientOpId of Object.keys(payload.seqs)) confirmedIds.add(clientOpId);
  }

  const confirmed = aligned.pending.filter((p) => confirmedIds.has(p.clientOpId));
  if (confirmed.length === 0) return aligned; // 已经处理过（例如重连后的重复 ack）

  const pending = aligned.pending.filter((p) => !confirmedIds.has(p.clientOpId));

  let shapes = aligned.shapes;
  if (payload.serverShape) {
    // 单条写的权威结果：直接覆盖（批量 ack 的 serverShape 为 null，不会走到这里）
    shapes = { ...shapes, [payload.serverShape.id]: cloneShape(payload.serverShape) };
  } else {
    // 没有 serverShape 时，用"本地已乐观应用的效果"落盘：删除类操作补 deletedAt，
    // 其余（含批量）保持乐观值，等服务端快照/后续广播校正
    for (const entry of confirmed) {
      if (entry.op.opType !== 'delete') continue;
      const current = shapes[entry.op.shapeId];
      if (current && !current.deletedAt) {
        shapes = {
          ...shapes,
          [entry.op.shapeId]: { ...current, deletedAt: new Date().toISOString() },
        };
      }
    }
  }

  const withoutEntry: SyncState = { ...aligned, shapes, pending };
  return {
    ...withoutEntry,
    shapes: reapplyPending(withoutEntry),
    stats: { ...aligned.stats, acked: aligned.stats.acked + confirmed.length },
  };
}

/** ack 里可能出现的所有 seq（单条 op 用 seq，批量用 seqs） */
function collectAckSeqs(payload: AckPayload): number[] {
  const out: number[] = [];
  if (typeof payload.seq === 'number') out.push(payload.seq);
  if (payload.seqs) {
    for (const value of Object.values(payload.seqs)) {
      if (typeof value === 'number') out.push(value);
    }
  }
  return out;
}

/** 用 ack 的 seq 推进本地序号；发现空洞就请求补齐 */
function alignFromAck(state: SyncState, payload: AckPayload, effects: SyncEffect[]): SyncState {
  const seqs = collectAckSeqs(payload);
  if (seqs.length === 0) return state;
  let candidate = state.seq;
  let hole = false;
  for (const seq of [...seqs].sort((a, b) => a - b)) {
    if (seq <= candidate) continue; // 已应用（广播先到了）
    if (seq === candidate + 1) {
      candidate = seq;
    } else {
      hole = true;
      break;
    }
  }
  const next: SyncState = { ...state, seq: candidate };
  if (!hole) return next;
  return requestSync({ ...next, awaitingSync: false }, effects);
}

function onReject(state: SyncState, payload: RejectedPayload, effects: SyncEffect[]): SyncState {
  const index = state.pending.findIndex((p) => p.clientOpId === payload.clientOpId);
  if (index < 0) return state;
  const entry = state.pending[index]!;

  /**
   * 批量写入是原子事务（服务端整批回滚），而且拒绝事件只带"第一条 op"的 clientOpId。
   * 所以同一个提交事务（txId）里的 op 必须一起处理：
   *  - 单 op 事务（绝大多数：创建 / 拖动 / 缩放 / 删除 / 改层级）走精确的回滚或冲突重放；
   *  - 多 op 事务（多选移动、撤销一个复合手势）整批回滚，避免"一半留下、一半回滚"的脏中间态。
   */
  const txEntries = state.pending.filter((p) => p.txId === entry.txId);
  const isAtomicBatch = txEntries.length > 1;

  // 允许重放的只有"单 op 且带 serverShape 的版本冲突"
  const canRetry =
    !isAtomicBatch &&
    payload.reason === ERROR_CODES.VERSION_CONFLICT &&
    !!payload.serverShape &&
    entry.attempts < MAX_VERSION_RETRY &&
    entry.op.opType === 'update' &&
    !!entry.op.patch;

  if (isAtomicBatch) {
    // 整批回滚：按逆操作撤销事务里每一条 op（逆序，保证后修改的先撤销）
    let current = state.shapes;
    const reversed = [...txEntries].reverse();
    for (const item of reversed) {
      current = applyOp(current, { ...item.inverse, clientOpId: item.clientOpId }).shapes;
      effects.push({ kind: 'undo-discard', txId: item.txId, clientOpId: item.clientOpId });
    }
    // 回滚后再把不属于该事务的 pending 效果重新叠上去
    const remaining = state.pending.filter((p) => p.txId !== entry.txId);
    let rebuilt = current;
    for (const item of remaining) rebuilt = applyOp(rebuilt, item.op).shapes;
    effects.push({
      kind: 'notice',
      level: 'error',
      text: `${reasonText(payload.reason)}${payload.message ? `：${payload.message}` : ''}（该批操作已整体撤销）`,
    });
    return {
      ...state,
      shapes: rebuilt,
      pending: remaining,
      stats: { ...state.stats, rejected: state.stats.rejected + txEntries.length },
    };
  }

  let pending = state.pending.filter((_, i) => i !== index);
  let shapes = state.shapes;

  effects.push({ kind: 'undo-discard', txId: entry.txId, clientOpId: entry.clientOpId });

  if (canRetry && payload.serverShape) {
    const base = payload.serverShape;
    // 以 serverShape 为新基底：本地视图先回到权威状态，再把其他 pending 叠回去
    const repaired: Record<string, Shape> = { ...shapes, [base.id]: cloneShape(base) };
    let current = repaired;
    for (const item of pending) current = applyOp(current, item.op).shapes;

    // 同一份 patch（绝对值语义）重新提交，只是 baseVersion 换成 serverShape.version
    const retryOp: ShapeOp = { ...entry.op, clientOpId: newId() };
    const applied = applyOp(current, retryOp);
    if (!applied.inverse) {
      effects.push({
        kind: 'notice',
        level: 'warn',
        text: '并发冲突：无法安全合并，已放弃这次修改',
      });
      return {
        ...state,
        shapes: current,
        pending,
        stats: { ...state.stats, rejected: state.stats.rejected + 1 },
      };
    }
    const retried: PendingOp = {
      clientOpId: retryOp.clientOpId,
      txId: entry.txId,
      op: retryOp,
      baseVersion: base.version,
      status: 'queued',
      attempts: entry.attempts + 1,
      inverse: applied.inverse,
    };
    pending = [...pending, retried];
    effects.push({ kind: 'send', ops: [retryOp] });
    effects.push({
      kind: 'undo-replace',
      txId: entry.txId,
      fromClientOpId: entry.clientOpId,
      item: { clientOpId: retryOp.clientOpId, inverse: applied.inverse },
    });
    effects.push({ kind: 'notice', level: 'info', text: '检测到并发修改，已基于最新状态重新提交' });
    return {
      ...state,
      shapes: applied.shapes,
      pending,
      stats: { ...state.stats, rejected: state.stats.rejected + 1 },
    };
  }

  // 回滚：优先用服务端返回的权威图形，否则按逆操作回退
  const inverse = entry.inverse;
  let current = shapes;
  if (payload.serverShape) {
    current = { ...current, [payload.serverShape.id]: cloneShape(payload.serverShape) };
  } else {
    current = applyOp(current, { ...inverse, clientOpId: entry.clientOpId }).shapes;
  }
  // 回滚后仍要把其它 pending 的效果重新叠上去
  let rebuilt = current;
  for (const item of pending) rebuilt = applyOp(rebuilt, item.op).shapes;

  const reason: ErrorCode = payload.reason;
  effects.push({
    kind: 'notice',
    level: 'error',
    text: `${reasonText(reason)}${payload.message ? `：${payload.message}` : ''}`,
  });
  return {
    ...state,
    shapes: rebuilt,
    pending,
    stats: { ...state.stats, rejected: state.stats.rejected + 1 },
  };
}

/** reject 的 reason 是 ErrorCode，文案只在这里兜底（UI 层还有更细的映射） */
function reasonText(reason: ErrorCode): string {
  switch (reason) {
    case ERROR_CODES.VERSION_CONFLICT:
      return '并发冲突，已放弃这次修改';
    case ERROR_CODES.FORBIDDEN:
      return '没有权限修改该图形';
    case ERROR_CODES.VALIDATION_FAILED:
      return '提交的数据不合法';
    case ERROR_CODES.RATE_LIMITED:
      return '操作过于频繁，请稍后再试';
    case ERROR_CODES.NOT_FOUND:
      return '图形已不存在';
    default:
      return '操作被服务端拒绝';
  }
}

// ---------------------------------------------------------------------------
// 重连补发
// ---------------------------------------------------------------------------

function onConnected(state: SyncState, effects: SyncEffect[]): SyncState {
  const unacked = state.pending.map((p) => p.op);
  if (unacked.length > 0) {
    // 靠 clientOpId 幂等：服务端已提交的会返回原 seq，不会重复落库
    for (let i = 0; i < unacked.length; i += MAX_BATCH) {
      effects.push({ kind: 'send', ops: unacked.slice(i, i + MAX_BATCH) });
    }
  }
  return {
    ...state,
    // 重连后所有 pending 都当作"待重发"
    pending: state.pending.map((p) => ({ ...p, status: 'queued' })),
    // 断线期间的缺口交给 room:join 的 sinceSeq；awaitingSync 复位以便再次检漏
    awaitingSync: false,
  };
}

// ---------------------------------------------------------------------------
// 主 reducer
// ---------------------------------------------------------------------------

export function syncReduce(state: SyncState, action: AnySyncAction): SyncResult {
  const effects: SyncEffect[] = [];
  switch (action.kind) {
    case 'reset':
      return { state: initialSyncState(action.boardId), effects };

    case 'local-ops': {
      let next = state;
      for (const spec of action.ops) {
        next = enqueue(next, spec, action.txId, action.label, effects);
      }
      return { state: next, effects };
    }

    case 'sent': {
      const ids = new Set(action.clientOpIds);
      return {
        state: {
          ...state,
          pending: state.pending.map((p) => (ids.has(p.clientOpId) ? { ...p, status: 'sent' } : p)),
        },
        effects,
      };
    }

    case 'connected':
      return { state: onConnected(state, effects), effects };

    case 'ack':
      return { state: onAck(state, action.payload, effects), effects };

    case 'reject':
      return { state: onReject(state, action.payload, effects), effects };

    case 'authority':
      return { state: onAuthority(state, action.seq, action.op, effects), effects };

    case 'board-state':
      return { state: onBoardState(state, action.payload, effects), effects };

    case 'board-ops':
      return { state: onBoardOps(state, action.payload, effects), effects };

    default:
      return { state, effects };
  }
}

// ---------------------------------------------------------------------------
// 只读辅助（UI / 撤销栈用）
// ---------------------------------------------------------------------------

/** 供 manager 使用：把大量 op 切成协议允许的 batch 大小（shape:batch 上限 200） */
export function chunkOps(ops: ShapeOp[], size = MAX_BATCH): ShapeOp[][] {
  const out: ShapeOp[][] = [];
  for (let i = 0; i < ops.length; i += size) out.push(ops.slice(i, i + size));
  return out;
}
