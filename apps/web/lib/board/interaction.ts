/**
 * 交互状态机：idle / drawing / dragging / resizing / marquee / panning。
 *
 * 设计要点：
 *  - 纯函数 reducer：输入是"当前状态 + 指针/键盘事件 + 只读上下文"，输出是
 *    "下一个状态 + 命令列表"。命令由组件解释成 store 调用，状态机自己不碰 DOM、
 *    不碰网络 —— 所以拖拽/框选/缩放的规则可以完整单测；
 *  - 拖动/缩放的中间过程只发 `mode: 'live'` 命令（本地预览，不发网络），
 *    抬手才发 `mode: 'commit'`（进入同步管道，多选移动一次 shape:batch 提交）；
 *  - 世界坐标：进入状态机时组件已经做过 screenToWorld。
 */
import type { Shape, ShapePatch, ShapeStyle, ShapeType } from '@collab/shared';

import type { Tool } from './defaults';
import { MIN_DRAW_SIZE } from './defaults';
import type { Bounds, Point, ResizeHandle } from './hitTest';
import {
  boundsFromPoints,
  getShapeBounds,
  resizeShape,
  round2,
  shapesInRect,
  translateShapes,
  unionBounds,
} from './hitTest';
import { createFreedraw, createShapeFromDrag } from './shapes';
import type { Viewport } from './renderer';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface PointerInfo {
  /** 世界坐标 */
  point: Point;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  /** 0 左键 / 1 中键 / 2 右键 */
  button: number;
  /** 空格键是否按下（临时平移） */
  space: boolean;
}

export type HitTarget =
  | { kind: 'none' }
  | { kind: 'shape'; shapeId: string }
  | { kind: 'handle'; shapeId: string; handle: ResizeHandle };

export interface InteractionContext {
  tool: Tool;
  /** 可见图形（已过滤软删除） */
  shapes: Record<string, Shape>;
  selection: string[];
  viewport: Viewport;
  boardId: string;
  createdBy: string | null;
  style: ShapeStyle;
  /** 新图形的 zIndex */
  nextZIndex: number;
}

export type InteractionState =
  | { kind: 'idle' }
  | {
      kind: 'drawing';
      /** text 工具不会进入 drawing（它直接开编辑器） */
      tool: Exclude<ShapeType, 'text'>;
      start: Point;
      current: Point;
      /** 自由画笔的轨迹 */
      points: Point[];
    }
  | {
      kind: 'dragging';
      start: Point;
      current: Point;
      shapeIds: string[];
      /** 拖拽前的 x/y，用于算 delta 与取消回滚 */
      originals: Record<string, Point>;
      moved: boolean;
    }
  | {
      kind: 'resizing';
      handle: ResizeHandle;
      shapeId: string;
      start: Point;
      current: Point;
      original: Shape;
      moved: boolean;
    }
  | { kind: 'marquee'; start: Point; current: Point; additive: boolean }
  | { kind: 'panning'; start: Point; current: Point; origin: Point };

export interface ShapePatchIntent {
  shapeId: string;
  patch: ShapePatch;
}

export type InteractionCommand =
  /** 改选中集 */
  | { kind: 'select'; ids: string[] }
  /** 创建图形（乐观 + 发送） */
  | { kind: 'create-shape'; shape: Shape }
  /** live：只更新本地预览；commit：进入同步管道（label 用于撤销栈展示） */
  | { kind: 'update-shapes'; patches: ShapePatchIntent[]; mode: 'live' | 'commit'; label?: string }
  | { kind: 'delete-shapes'; ids: string[] }
  | { kind: 'set-viewport'; viewport: Viewport }
  | { kind: 'set-tool'; tool: Tool }
  /** 请求打开文本编辑器：shapeId 为 null 表示新建 */
  | { kind: 'open-text-editor'; shapeId: string | null; at: Point; initial: string }
  | { kind: 'undo' }
  | { kind: 'redo' };

export type InteractionEvent =
  | { type: 'pointer-down'; pointer: PointerInfo; target: HitTarget }
  | { type: 'pointer-move'; pointer: PointerInfo }
  | { type: 'pointer-up'; pointer: PointerInfo }
  | { type: 'pointer-cancel' }
  | { type: 'double-click'; pointer: PointerInfo; target: HitTarget }
  | { type: 'key-down'; key: string; shift: boolean; ctrl: boolean; meta: boolean }
  | { type: 'blur' };

export interface InteractionResult {
  state: InteractionState;
  commands: InteractionCommand[];
}

export function initialInteractionState(): InteractionState {
  return { kind: 'idle' };
}

/** 判定"误点"的阈值（世界单位，随缩放折算） */
function dragThreshold(vp: Viewport): number {
  return 2 / Math.max(vp.zoom, 0.01);
}

// ---------------------------------------------------------------------------
// 预览与辅助（纯计算，供组件绘制）
// ---------------------------------------------------------------------------

/** 从状态机构造"正在绘制"的预览图形（不走 store，纯渲染用） */
export function getPreviewShape(state: InteractionState, ctx: InteractionContext): Shape | null {
  if (state.kind !== 'drawing') return null;
  const args = {
    boardId: ctx.boardId,
    style: ctx.style,
    zIndex: ctx.nextZIndex,
    createdBy: ctx.createdBy,
  };
  if (state.tool === 'freedraw') {
    if (state.points.length < 2) return null;
    return createFreedraw({ ...args, points: state.points });
  }
  return createShapeFromDrag({
    ...args,
    type: state.tool,
    start: state.start,
    current: state.current,
  });
}

/** 框选矩形（世界坐标） */
export function getMarqueeRect(state: InteractionState): Bounds | null {
  if (state.kind !== 'marquee') return null;
  return boundsFromPoints(state.start, state.current);
}

/** 拖拽中的实时 patch（本地预览用） */
function dragPatches(state: Extract<InteractionState, { kind: 'dragging' }>): ShapePatchIntent[] {
  const dx = round2(state.current.x - state.start.x);
  const dy = round2(state.current.y - state.start.y);
  return Object.entries(state.originals).map(([shapeId, origin]) => ({
    shapeId,
    patch: { x: round2(origin.x + dx), y: round2(origin.y + dy) },
  }));
}

/** 缩放中的实时 patch */
function resizePatchList(
  state: Extract<InteractionState, { kind: 'resizing' }>,
): ShapePatchIntent[] {
  return [
    { shapeId: state.shapeId, patch: resizeShape(state.original, state.handle, state.current) },
  ];
}

/** 撤销/重做快捷键判定：Ctrl+Z / Cmd+Z，Shift 决定方向 */
function undoRedoCommand(
  event: Extract<InteractionEvent, { type: 'key-down' }>,
): InteractionCommand | null {
  const mod = event.ctrl || event.meta;
  if (!mod) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shift ? { kind: 'redo' } : { kind: 'undo' };
  if (key === 'y') return { kind: 'redo' };
  return null;
}

/** 工具快捷键 */
const TOOL_HOTKEYS: Record<string, Tool> = {
  v: 'select',
  h: 'pan',
  r: 'rect',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  p: 'freedraw',
  t: 'text',
};

// ---------------------------------------------------------------------------
// 主 reducer
// ---------------------------------------------------------------------------

export function reduceInteraction(
  state: InteractionState,
  event: InteractionEvent,
  ctx: InteractionContext,
): InteractionResult {
  switch (event.type) {
    case 'pointer-down':
      return onPointerDown(state, event, ctx);
    case 'pointer-move':
      return onPointerMove(state, event, ctx);
    case 'pointer-up':
      return onPointerUp(state, event, ctx);
    case 'pointer-cancel':
      return cancelInteraction(state);
    case 'double-click':
      return onDoubleClick(state, event, ctx);
    case 'key-down':
      return onKeyDown(state, event, ctx);
    case 'blur':
      return cancelInteraction(state);
    default:
      return { state, commands: [] };
  }
}

function cancelInteraction(state: InteractionState): InteractionResult {
  switch (state.kind) {
    case 'idle':
      return { state, commands: [] };
    case 'dragging': {
      // 回滚到拖拽前的坐标：只改本地预览，不发网络
      const patches = Object.entries(state.originals).map(([shapeId, origin]) => ({
        shapeId,
        patch: { x: origin.x, y: origin.y },
      }));
      return {
        state: { kind: 'idle' },
        commands: patches.length ? [{ kind: 'update-shapes', patches, mode: 'live' }] : [],
      };
    }
    case 'resizing':
      return {
        state: { kind: 'idle' },
        commands: [
          {
            kind: 'update-shapes',
            patches: [
              {
                shapeId: state.shapeId,
                patch: {
                  x: state.original.x,
                  y: state.original.y,
                  w: state.original.w,
                  h: state.original.h,
                  data: state.original.data,
                },
              },
            ],
            mode: 'live',
          },
        ],
      };
    default:
      return { state: { kind: 'idle' }, commands: [] };
  }
}

function onPointerDown(
  state: InteractionState,
  event: Extract<InteractionEvent, { type: 'pointer-down' }>,
  ctx: InteractionContext,
): InteractionResult {
  const { pointer, target } = event;
  if (pointer.button === 2) return { state, commands: [] }; // 右键不参与

  // 平移：中键 / 平移工具 / 空格
  if (pointer.button === 1 || ctx.tool === 'pan' || pointer.space) {
    return {
      state: {
        kind: 'panning',
        start: pointer.point,
        current: pointer.point,
        origin: { x: ctx.viewport.x, y: ctx.viewport.y },
      },
      commands: [],
    };
  }

  // 绘制工具
  if (ctx.tool !== 'select') {
    if (ctx.tool === 'text') {
      return {
        state,
        commands: [{ kind: 'open-text-editor', shapeId: null, at: pointer.point, initial: '' }],
      };
    }
    return {
      state: {
        kind: 'drawing',
        tool: ctx.tool,
        start: pointer.point,
        current: pointer.point,
        points: ctx.tool === 'freedraw' ? [pointer.point] : [],
      },
      commands: [],
    };
  }

  // 选择工具：控制点优先于图形
  if (target.kind === 'handle') {
    const shape = ctx.shapes[target.shapeId];
    if (!shape) return { state, commands: [] };
    return {
      state: {
        kind: 'resizing',
        handle: target.handle,
        shapeId: target.shapeId,
        start: pointer.point,
        current: pointer.point,
        original: shape,
        moved: false,
      },
      commands: [],
    };
  }

  if (target.kind === 'shape') {
    const shape = ctx.shapes[target.shapeId];
    if (!shape) return { state, commands: [] };
    if (pointer.shift) {
      // Shift 点选：加选 / 减选，不进入拖拽
      const next = ctx.selection.includes(target.shapeId)
        ? ctx.selection.filter((id) => id !== target.shapeId)
        : [...ctx.selection, target.shapeId];
      return { state: { kind: 'idle' }, commands: [{ kind: 'select', ids: next }] };
    }
    const ids = ctx.selection.includes(target.shapeId) ? ctx.selection : [target.shapeId];
    const originals: Record<string, Point> = {};
    for (const id of ids) {
      const s = ctx.shapes[id];
      if (s) originals[id] = { x: s.x, y: s.y };
    }
    const commands: InteractionCommand[] = ctx.selection.includes(target.shapeId)
      ? []
      : [{ kind: 'select', ids }];
    return {
      state: {
        kind: 'dragging',
        start: pointer.point,
        current: pointer.point,
        shapeIds: ids,
        originals,
        moved: false,
      },
      commands,
    };
  }

  // 空白处：框选（Shift 保留原选中集）
  return {
    state: {
      kind: 'marquee',
      start: pointer.point,
      current: pointer.point,
      additive: pointer.shift,
    },
    commands: pointer.shift ? [] : [{ kind: 'select', ids: [] }],
  };
}

function onPointerMove(
  state: InteractionState,
  event: Extract<InteractionEvent, { type: 'pointer-move' }>,
  ctx: InteractionContext,
): InteractionResult {
  const { point } = event.pointer;
  switch (state.kind) {
    case 'drawing': {
      if (state.tool === 'freedraw') {
        const last = state.points[state.points.length - 1];
        // 采点最小间距：漏掉过密的点，避免点集爆掉协议上界
        if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1.5) {
          return { state, commands: [] };
        }
        return {
          state: { ...state, current: point, points: [...state.points, point] },
          commands: [],
        };
      }
      return { state: { ...state, current: point }, commands: [] };
    }
    case 'dragging': {
      const threshold = dragThreshold(ctx.viewport);
      const moved =
        state.moved || Math.hypot(point.x - state.start.x, point.y - state.start.y) >= threshold;
      const next = { ...state, current: point, moved };
      return {
        state: next,
        commands: moved
          ? [{ kind: 'update-shapes', patches: dragPatches(next), mode: 'live' }]
          : [],
      };
    }
    case 'resizing': {
      const threshold = dragThreshold(ctx.viewport);
      const moved =
        state.moved || Math.hypot(point.x - state.start.x, point.y - state.start.y) >= threshold;
      const next = { ...state, current: point, moved };
      return {
        state: next,
        commands: moved
          ? [{ kind: 'update-shapes', patches: resizePatchList(next), mode: 'live' }]
          : [],
      };
    }
    case 'marquee':
      return { state: { ...state, current: point }, commands: [] };
    case 'panning': {
      const dx = point.x - state.start.x;
      const dy = point.y - state.start.y;
      return {
        state: { ...state, current: point },
        commands: [
          {
            kind: 'set-viewport',
            viewport: {
              zoom: ctx.viewport.zoom,
              x: state.origin.x + dx,
              y: state.origin.y + dy,
            },
          },
        ],
      };
    }
    default:
      return { state, commands: [] };
  }
}

function onPointerUp(
  state: InteractionState,
  event: Extract<InteractionEvent, { type: 'pointer-up' }>,
  ctx: InteractionContext,
): InteractionResult {
  const { point } = event.pointer;
  switch (state.kind) {
    case 'drawing': {
      const args = {
        boardId: ctx.boardId,
        style: ctx.style,
        zIndex: ctx.nextZIndex,
        createdBy: ctx.createdBy,
      };
      if (state.tool === 'freedraw') {
        // 抬手点也补进轨迹（否则最后一小段会缺）
        const points = state.points;
        const last = points[points.length - 1];
        const track =
          last && Math.hypot(point.x - last.x, point.y - last.y) >= 1.5
            ? [...points, point]
            : points;
        if (track.length < 2) return { state: initialInteractionState(), commands: [] };
        const shape = createFreedraw({ ...args, points: track });
        return {
          state: initialInteractionState(),
          commands: [
            { kind: 'create-shape', shape },
            { kind: 'select', ids: [shape.id] },
            { kind: 'set-tool', tool: 'select' },
          ],
        };
      }
      // 结束点用事件里的坐标（pointer-move 可能没跟上最后一次移动）
      const dx = Math.abs(point.x - state.start.x);
      const dy = Math.abs(point.y - state.start.y);
      // 直线/箭头只看端点距离，矩形/椭圆看包围盒尺寸
      const tooSmall =
        state.tool === 'line' || state.tool === 'arrow'
          ? Math.hypot(dx, dy) < MIN_DRAW_SIZE
          : dx < MIN_DRAW_SIZE && dy < MIN_DRAW_SIZE;
      if (tooSmall) return { state: initialInteractionState(), commands: [] };
      const shape = createShapeFromDrag({
        ...args,
        type: state.tool,
        start: state.start,
        current: point,
      });
      return {
        state: initialInteractionState(),
        commands: [
          { kind: 'create-shape', shape },
          { kind: 'select', ids: [shape.id] },
          { kind: 'set-tool', tool: 'select' },
        ],
      };
    }
    case 'dragging': {
      if (!state.moved) return { state: initialInteractionState(), commands: [] };
      const next = { ...state, current: point };
      return {
        state: initialInteractionState(),
        commands: [
          { kind: 'update-shapes', patches: dragPatches(next), mode: 'commit', label: '移动图形' },
        ],
      };
    }
    case 'resizing': {
      if (!state.moved) return { state: initialInteractionState(), commands: [] };
      const next = { ...state, current: point };
      return {
        state: initialInteractionState(),
        commands: [
          {
            kind: 'update-shapes',
            patches: resizePatchList(next),
            mode: 'commit',
            label: '缩放图形',
          },
        ],
      };
    }
    case 'marquee': {
      const rect = boundsFromPoints(state.start, state.current);
      const inside = shapesInRect(Object.values(ctx.shapes), rect).map((s) => s.id);
      const ids = state.additive ? Array.from(new Set([...ctx.selection, ...inside])) : inside;
      return {
        state: initialInteractionState(),
        commands: [{ kind: 'select', ids }],
      };
    }
    case 'panning':
      return { state: initialInteractionState(), commands: [] };
    default:
      return { state, commands: [] };
  }
}

function onDoubleClick(
  state: InteractionState,
  event: Extract<InteractionEvent, { type: 'double-click' }>,
  ctx: InteractionContext,
): InteractionResult {
  if (ctx.tool !== 'select') return { state, commands: [] };
  if (event.target.kind !== 'shape') return { state, commands: [] };
  const shape = ctx.shapes[event.target.shapeId];
  if (!shape) return { state, commands: [] };
  if (shape.type !== 'text') return { state, commands: [] };
  return {
    state: initialInteractionState(),
    commands: [
      {
        kind: 'open-text-editor',
        shapeId: shape.id,
        at: { x: shape.x, y: shape.y },
        initial: shape.data.text ?? '',
      },
    ],
  };
}

function onKeyDown(
  state: InteractionState,
  event: Extract<InteractionEvent, { type: 'key-down' }>,
  ctx: InteractionContext,
): InteractionResult {
  const undoRedo = undoRedoCommand(event);
  if (undoRedo) return { state, commands: [undoRedo] };

  if (event.key === 'Escape') return cancelInteraction(state);

  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (ctx.selection.length === 0) return { state, commands: [] };
    return {
      state,
      commands: [
        { kind: 'delete-shapes', ids: [...ctx.selection] },
        { kind: 'select', ids: [] },
      ],
    };
  }

  if (!event.ctrl && !event.meta) {
    const tool = TOOL_HOTKEYS[event.key.toLowerCase()];
    if (tool) return { state, commands: [{ kind: 'set-tool', tool }] };
  }

  return { state, commands: [] };
}

/** 供工具栏使用：计算选中集的包围盒（世界坐标） */
export function selectionBounds(shapes: Record<string, Shape>, selection: string[]): Bounds | null {
  const list: Bounds[] = [];
  for (const id of selection) {
    const s = shapes[id];
    if (s) list.push(getShapeBounds(s));
  }
  return unionBounds(list);
}

/** 供工具栏使用：整体平移选中集（返回 patch 列表） */
export function translateSelection(
  shapes: Record<string, Shape>,
  selection: string[],
  dx: number,
  dy: number,
): ShapePatchIntent[] {
  const list: Shape[] = [];
  for (const id of selection) {
    const s = shapes[id];
    if (s) list.push(s);
  }
  return translateShapes(list, dx, dy);
}
