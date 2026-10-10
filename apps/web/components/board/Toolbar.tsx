'use client';

/**
 * 工具栏：工具选择、颜色 / 线宽、层级、撤销重做、删除、缩放。
 *
 * 与 store 的交互都走 store 动作：样式改选中集、层级走 shape:batch、撤销重做走本地栈。
 */
import { clsx } from 'clsx';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  ChevronsDown,
  ChevronsUp,
  Circle,
  Hand,
  Minus,
  MousePointer2,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import type { Tool } from '../../lib/board/defaults';
import { STROKE_COLORS, STROKE_WIDTHS, TOOL_LABELS } from '../../lib/board/defaults';
import { computeLayerPatches, visibleShapes } from '../../lib/board/layers';
import { useBoardStore } from '../../stores/board';

const TOOL_ICONS: Record<Tool, typeof Square> = {
  select: MousePointer2,
  pan: Hand,
  rect: Square,
  ellipse: Circle,
  line: Minus,
  arrow: ArrowUpRight,
  freedraw: Pencil,
  text: Type,
};

const TOOL_ORDER: Tool[] = [
  'select',
  'pan',
  'rect',
  'ellipse',
  'line',
  'arrow',
  'freedraw',
  'text',
];

const TOOL_HINTS: Record<Tool, string> = {
  select: '选择 (V)',
  pan: '平移 (H / 中键 / 空格拖拽)',
  rect: '矩形 (R)',
  ellipse: '椭圆 (O)',
  line: '直线 (L)',
  arrow: '箭头 (A)',
  freedraw: '自由画 (P)',
  text: '文本 (T)',
};

export function Toolbar() {
  const tool = useBoardStore((state) => state.tool);
  const setTool = useBoardStore((state) => state.setTool);
  const style = useBoardStore((state) => state.style);
  const setStyle = useBoardStore((state) => state.setStyle);
  const selection = useBoardStore((state) => state.selection);
  const undoStack = useBoardStore((state) => state.undoStack);
  const redoStack = useBoardStore((state) => state.redoStack);
  const undo = useBoardStore((state) => state.undo);
  const redo = useBoardStore((state) => state.redo);
  const deleteShapes = useBoardStore((state) => state.deleteShapes);
  const applyLayerPatches = useBoardStore((state) => state.applyLayerPatches);
  const zoom = useBoardStore((state) => state.viewport.zoom);
  const zoomBy = useBoardStore((state) => state.zoomBy);
  const resetViewport = useBoardStore((state) => state.resetViewport);
  const shapes = useBoardStore((state) => state.sync.shapes);

  const hasSelection = selection.length > 0;
  // 可见图形数（软删除不算），同时作为 e2e 的断言抓手
  const shapeCount = Object.values(shapes).filter((shape) => !shape.deletedAt).length;

  /** 以画布中心为锚缩放（画布在 56px 顶栏之下） */
  const zoomAtCenter = (factor: number) => {
    zoomBy(factor, {
      x: window.innerWidth / 2,
      y: (window.innerHeight - 56) / 2,
    });
  };

  const moveLayer = (direction: 'up' | 'down' | 'front' | 'back') => {
    const store = useBoardStore.getState();
    const patches = computeLayerPatches(
      visibleShapes(store.sync.shapes),
      store.selection,
      direction,
    );
    if (patches.length === 0) {
      store.pushNotice('info', '已经到边界了');
      return;
    }
    applyLayerPatches(patches);
  };

  return (
    <div className="pointer-events-none absolute top-3 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-2">
      {/* 主工具栏 */}
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-line bg-panel/95 p-1 shadow-sm backdrop-blur">
        {TOOL_ORDER.map((item) => {
          const Icon = TOOL_ICONS[item];
          const active = tool === item;
          return (
            <button
              key={item}
              type="button"
              data-testid={item === 'rect' ? 'tool-rect' : undefined}
              title={TOOL_HINTS[item]}
              aria-label={TOOL_LABELS[item]}
              aria-pressed={active}
              onClick={() => setTool(item)}
              className={clsx(
                'grid h-9 w-9 place-items-center rounded-lg transition-colors',
                active ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-app',
              )}
            >
              <Icon size={18} />
            </button>
          );
        })}

        <span className="mx-1 h-6 w-px bg-line" />

        {/* 描边色 */}
        <div className="flex items-center gap-1 px-1">
          {STROKE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              title={`描边 ${color}`}
              aria-label={`描边 ${color}`}
              onClick={() => setStyle({ stroke: color })}
              className={clsx(
                'h-5 w-5 rounded-full border transition-transform',
                style.stroke === color
                  ? 'scale-110 border-accent ring-2 ring-accent/30'
                  : 'border-line',
              )}
              style={{ background: color }}
            />
          ))}
        </div>

        <span className="mx-1 h-6 w-px bg-line" />

        {/* 线宽 */}
        <div className="flex items-center gap-0.5 px-1">
          {STROKE_WIDTHS.map((width) => (
            <button
              key={width}
              type="button"
              title={`线宽 ${width}px`}
              aria-label={`线宽 ${width}`}
              onClick={() => setStyle({ strokeWidth: width })}
              className={clsx(
                'grid h-7 w-7 place-items-center rounded-lg',
                style.strokeWidth === width
                  ? 'bg-accent-soft text-accent'
                  : 'text-ink hover:bg-app',
              )}
            >
              <span
                className="block rounded-full bg-current"
                style={{ width: 16, height: Math.max(1, width) }}
              />
            </button>
          ))}
        </div>

        <span className="mx-1 h-6 w-px bg-line" />

        {/* 层级 */}
        <button
          type="button"
          title="上移一层"
          aria-label="上移一层"
          disabled={!hasSelection}
          onClick={() => moveLayer('up')}
          className="grid h-9 w-9 place-items-center rounded-lg text-ink transition-colors hover:bg-app disabled:opacity-40"
        >
          <ArrowUp size={18} />
        </button>
        <button
          type="button"
          title="下移一层"
          aria-label="下移一层"
          disabled={!hasSelection}
          onClick={() => moveLayer('down')}
          className="grid h-9 w-9 place-items-center rounded-lg text-ink transition-colors hover:bg-app disabled:opacity-40"
        >
          <ArrowDown size={18} />
        </button>
        <button
          type="button"
          title="置于顶层"
          aria-label="置于顶层"
          disabled={!hasSelection}
          onClick={() => moveLayer('front')}
          className="grid h-9 w-9 place-items-center rounded-lg text-ink transition-colors hover:bg-app disabled:opacity-40"
        >
          <ChevronsUp size={18} />
        </button>
        <button
          type="button"
          title="置于底层"
          aria-label="置于底层"
          disabled={!hasSelection}
          onClick={() => moveLayer('back')}
          className="grid h-9 w-9 place-items-center rounded-lg text-ink transition-colors hover:bg-app disabled:opacity-40"
        >
          <ChevronsDown size={18} />
        </button>

        <span className="mx-1 h-6 w-px bg-line" />

        {/* 撤销 / 重做 / 删除 */}
        <button
          type="button"
          title="撤销 (Ctrl+Z)"
          aria-label="撤销"
          disabled={undoStack.length === 0}
          onClick={undo}
          className="grid h-9 w-9 place-items-center rounded-lg text-ink transition-colors hover:bg-app disabled:opacity-40"
        >
          <Undo2 size={18} />
        </button>
        <button
          type="button"
          title="重做 (Ctrl+Shift+Z)"
          aria-label="重做"
          disabled={redoStack.length === 0}
          onClick={redo}
          className="grid h-9 w-9 place-items-center rounded-lg text-ink transition-colors hover:bg-app disabled:opacity-40"
        >
          <Redo2 size={18} />
        </button>
        <button
          type="button"
          title="删除选中 (Delete)"
          aria-label="删除选中"
          disabled={!hasSelection}
          onClick={() => deleteShapes(selection)}
          className="grid h-9 w-9 place-items-center rounded-lg text-danger transition-colors hover:bg-danger-soft disabled:opacity-40"
        >
          <Trash2 size={18} />
        </button>
      </div>

      <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-line bg-panel/90 px-1.5 py-0.5 text-[11px] text-muted shadow-sm">
        {/* 图形计数：数值单独成节点，e2e 直接断言 */}
        <span className="px-1" title="画布上的图形数量">
          图形
          <span data-testid="shape-count" className="ml-1 tabular-nums text-ink">
            {shapeCount}
          </span>
        </span>
        <span className="h-4 w-px bg-line" />
        <button
          type="button"
          title="缩小"
          aria-label="缩小"
          onClick={() => zoomAtCenter(1 / 1.25)}
          className="grid h-6 w-6 place-items-center rounded text-ink hover:bg-app"
        >
          <ZoomOut size={13} />
        </button>
        <button
          type="button"
          title="重置视口"
          onClick={resetViewport}
          className="min-w-11 rounded px-1 tabular-nums hover:bg-app"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          title="放大"
          aria-label="放大"
          onClick={() => zoomAtCenter(1.25)}
          className="grid h-6 w-6 place-items-center rounded text-ink hover:bg-app"
        >
          <ZoomIn size={13} />
        </button>
      </div>
    </div>
  );
}
