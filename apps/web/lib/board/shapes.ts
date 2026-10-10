/**
 * 图元层：六种图元的绘制、文本度量、以及"从拖拽手势构造图形"的工厂函数。
 *
 * - 绘制只依赖 CanvasRenderingContext2D，不依赖 React / 状态；
 * - 形状约定：rect/ellipse/text 用 (x,y,w,h)；(line/arrow/freedraw) 额外用
 *   data.points（相对 x,y 的点集），w/h 允许为负（line 的 w/h 是起点到终点的位移）；
 * - 文本尺寸用离屏 canvas 度量，非浏览器环境（jsdom / SSR）退化为估算，
 *   保证纯逻辑测试不依赖 canvas 实现。
 */
import type { Shape, ShapeStyle, ShapeType } from '@collab/shared';

import { DEFAULT_STYLE, newId } from './defaults';
import type { Point } from './hitTest';
import { getShapeBounds, round2 } from './hitTest';

/** 文本图形的内边距与行高倍率（度量与绘制必须用同一组常量） */
export const TEXT_PADDING_X = 6;
export const TEXT_PADDING_Y = 4;
export const TEXT_LINE_HEIGHT = 1.35;

export const FONT_FAMILY =
  'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

export function fontString(fontSize: number): string {
  return `${fontSize}px ${FONT_FAMILY}`;
}

/** 坐标与尺寸裁剪到协议上界（±1e6），防止 NaN / Infinity 被服务端拒掉 */
function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? Math.max(-1_000_000, Math.min(1_000_000, n)) : fallback;
}

// ---------------------------------------------------------------------------
// 文本度量
// ---------------------------------------------------------------------------

let measureCanvas: HTMLCanvasElement | null | undefined;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCanvas === undefined) {
    try {
      measureCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
      measureCanvas?.getContext('2d');
    } catch {
      measureCanvas = null;
    }
  }
  if (!measureCanvas) return null;
  try {
    return measureCanvas.getContext('2d');
  } catch {
    return null;
  }
}

/** 文本图形的包围盒尺寸（含内边距） */
export function measureTextSize(text: string, fontSize: number): { w: number; h: number } {
  const lines = text.split('\n');
  const lineHeight = fontSize * TEXT_LINE_HEIGHT;
  const ctx = getMeasureContext();
  let maxWidth = 0;
  if (ctx) {
    ctx.font = fontString(fontSize);
    for (const line of lines) {
      maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
    }
  } else {
    // 无 canvas（SSR / jsdom）：按字符宽度估算，仅用于兜底布局
    for (const line of lines) {
      maxWidth = Math.max(maxWidth, [...line].length * fontSize * 0.62);
    }
  }
  return {
    w: Math.max(1, Math.ceil(maxWidth) + TEXT_PADDING_X * 2),
    h: Math.max(1, Math.ceil(lines.length * lineHeight) + TEXT_PADDING_Y * 2),
  };
}

// ---------------------------------------------------------------------------
// 构造：从拖拽 / 点集 / 文本生成线上图形
// ---------------------------------------------------------------------------

export interface ShapeFactoryArgs {
  boardId: string;
  style: ShapeStyle;
  zIndex: number;
  createdBy: string | null;
}

/** 合并用户样式与默认样式，并按图元类型做合理兜底（线类图元没有填充） */
export function resolveStyle(style: ShapeStyle | undefined, type: ShapeType): ShapeStyle {
  const merged: ShapeStyle = { ...DEFAULT_STYLE, ...style };
  if (type !== 'rect' && type !== 'ellipse' && type !== 'text') {
    delete merged.fill;
  }
  return merged;
}

interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
  data: Shape['data'];
}

/** 组装一条完整线上图形（协议 ShapeSchema 要求所有字段都有值） */
function buildShape(args: ShapeFactoryArgs, type: ShapeType, geometry: Geometry): Shape {
  const now = new Date().toISOString();
  return {
    id: newId(),
    boardId: args.boardId,
    type,
    x: finite(round2(geometry.x)),
    y: finite(round2(geometry.y)),
    w: finite(round2(geometry.w)),
    h: finite(round2(geometry.h)),
    rotation: 0,
    zIndex: args.zIndex,
    style: resolveStyle(args.style, type),
    data: geometry.data,
    version: 1,
    createdBy: args.createdBy,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 拖拽创建 rect / ellipse / line / arrow。
 * line/arrow 的 (w,h) 是位移（可为负）；rect/ellipse 归一化成正尺寸。
 */
export function createShapeFromDrag(
  args: ShapeFactoryArgs & {
    type: 'rect' | 'ellipse' | 'line' | 'arrow';
    start: Point;
    current: Point;
  },
): Shape {
  const { type, start, current } = args;
  if (type === 'line' || type === 'arrow') {
    const dx = round2(current.x - start.x);
    const dy = round2(current.y - start.y);
    return buildShape(args, type, {
      x: start.x,
      y: start.y,
      w: dx,
      h: dy,
      // 点集用相对坐标：移动图形只需改 x/y
      data: {
        points: [
          { x: 0, y: 0 },
          { x: dx, y: dy },
        ],
      },
    });
  }
  return buildShape(args, type, {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    w: Math.abs(current.x - start.x),
    h: Math.abs(current.y - start.y),
    data: {},
  });
}

/** 自由画笔：世界坐标点集 → 相对点集 + 包围盒 */
export function createFreedraw(args: ShapeFactoryArgs & { points: Point[] }): Shape {
  const pts = args.points;
  const first = pts[0] ?? { x: 0, y: 0 };
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x;
  let maxY = first.y;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return buildShape(args, 'freedraw', {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    data: { points: pts.map((p) => ({ x: round2(p.x - minX), y: round2(p.y - minY) })) },
  });
}

/** 文本：按内容度量出包围盒 */
export function createText(args: ShapeFactoryArgs & { at: Point; text: string }): Shape {
  const fontSize = args.style.fontSize ?? DEFAULT_STYLE.fontSize;
  const size = measureTextSize(args.text, fontSize);
  return buildShape(args, 'text', {
    x: args.at.x,
    y: args.at.y,
    w: size.w,
    h: size.h,
    data: { text: args.text },
  });
}

/** 修改文本内容后重算尺寸（保留左上角不动） */
export function withTextContent(shape: Shape, text: string): Shape {
  const size = measureTextSize(text, shape.style.fontSize ?? DEFAULT_STYLE.fontSize);
  return { ...shape, data: { ...shape.data, text }, w: size.w, h: size.h };
}

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

function applyStrokeStyle(ctx: CanvasRenderingContext2D, shape: Shape): void {
  const stroke = shape.style.stroke ?? DEFAULT_STYLE.stroke;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(0.1, shape.style.strokeWidth ?? DEFAULT_STYLE.strokeWidth);
  ctx.globalAlpha = shape.style.opacity ?? 1;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const dash = shape.style.dash;
  ctx.setLineDash(dash && dash.length > 0 ? dash : []);
}

function fillIfNeeded(ctx: CanvasRenderingContext2D, shape: Shape): void {
  const fill = shape.style.fill;
  if (fill && fill !== 'transparent' && fill !== 'none') {
    ctx.fillStyle = fill;
    ctx.fill();
  }
}

/** 绘制单个图形（世界坐标已由 ctx 变换处理） */
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.save();
  try {
    applyStrokeStyle(ctx, shape);
    const bounds = getShapeBounds(shape);

    if (shape.rotation) {
      const cx = bounds.x + bounds.w / 2;
      const cy = bounds.y + bounds.h / 2;
      ctx.translate(cx, cy);
      ctx.rotate((shape.rotation * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }

    switch (shape.type) {
      case 'rect': {
        ctx.beginPath();
        ctx.rect(bounds.x, bounds.y, bounds.w, bounds.h);
        fillIfNeeded(ctx, shape);
        ctx.stroke();
        break;
      }
      case 'ellipse': {
        ctx.beginPath();
        ctx.ellipse(
          bounds.x + bounds.w / 2,
          bounds.y + bounds.h / 2,
          Math.max(bounds.w / 2, 0.01),
          Math.max(bounds.h / 2, 0.01),
          0,
          0,
          Math.PI * 2,
        );
        fillIfNeeded(ctx, shape);
        ctx.stroke();
        break;
      }
      case 'line': {
        const pts = shape.data.points ?? [];
        if (pts.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(shape.x + pts[0]!.x, shape.y + pts[0]!.y);
          for (let i = 1; i < pts.length; i += 1) {
            const p = pts[i]!;
            ctx.lineTo(shape.x + p.x, shape.y + p.y);
          }
          ctx.stroke();
        } else {
          // 兜底：没有点集时用 (x,y)+(w,h) 画一条线
          ctx.beginPath();
          ctx.moveTo(shape.x, shape.y);
          ctx.lineTo(shape.x + shape.w, shape.y + shape.h);
          ctx.stroke();
        }
        break;
      }
      case 'arrow': {
        const pts = shape.data.points ?? [];
        const from =
          pts.length >= 2
            ? { x: shape.x + pts[0]!.x, y: shape.y + pts[0]!.y }
            : { x: shape.x, y: shape.y };
        const to =
          pts.length >= 2
            ? { x: shape.x + pts[pts.length - 1]!.x, y: shape.y + pts[pts.length - 1]!.y }
            : { x: shape.x + shape.w, y: shape.y + shape.h };
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        // 箭头头部用实心三角，尺寸随线宽增长
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const headLen = Math.max(10, (shape.style.strokeWidth ?? 2) * 3.2);
        const headWide = headLen * 0.55;
        ctx.beginPath();
        ctx.moveTo(to.x, to.y);
        ctx.lineTo(
          to.x - headLen * Math.cos(angle) + headWide * Math.sin(angle),
          to.y - headLen * Math.sin(angle) - headWide * Math.cos(angle),
        );
        ctx.lineTo(
          to.x - headLen * Math.cos(angle) - headWide * Math.sin(angle),
          to.y - headLen * Math.sin(angle) + headWide * Math.cos(angle),
        );
        ctx.closePath();
        ctx.fillStyle = shape.style.stroke ?? DEFAULT_STYLE.stroke;
        ctx.fill();
        break;
      }
      case 'freedraw': {
        const pts = shape.data.points ?? [];
        if (pts.length === 0) break;
        ctx.beginPath();
        const first = pts[0]!;
        ctx.moveTo(shape.x + first.x, shape.y + first.y);
        if (pts.length === 1) {
          ctx.lineTo(shape.x + first.x + 0.1, shape.y + first.y + 0.1);
        } else {
          for (let i = 1; i < pts.length; i += 1) {
            const p = pts[i]!;
            ctx.lineTo(shape.x + p.x, shape.y + p.y);
          }
        }
        ctx.stroke();
        break;
      }
      case 'text': {
        const fontSize = shape.style.fontSize ?? DEFAULT_STYLE.fontSize;
        ctx.font = fontString(fontSize);
        ctx.textBaseline = 'top';
        ctx.fillStyle = shape.style.stroke ?? DEFAULT_STYLE.stroke;
        const lines = (shape.data.text ?? '').split('\n');
        const lineHeight = fontSize * TEXT_LINE_HEIGHT;
        lines.forEach((line, index) => {
          ctx.fillText(
            line,
            shape.x + TEXT_PADDING_X,
            shape.y + TEXT_PADDING_Y + index * lineHeight,
          );
        });
        break;
      }
      default:
        break;
    }
  } finally {
    ctx.restore();
  }
}

/** 绘制选中态虚线框（覆盖层用，屏幕坐标） */
export function drawSelectionOutline(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  color = '#4c8dff',
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(rect.x - 0.5, rect.y - 0.5, rect.w + 1, rect.h + 1);
  ctx.restore();
}

/** 绘制 8 个缩放控制点（屏幕坐标，位置为控制点中心） */
export function drawHandles(
  ctx: CanvasRenderingContext2D,
  positions: { x: number; y: number }[],
  size: number,
  color = '#4c8dff',
): void {
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  for (const p of positions) {
    ctx.beginPath();
    ctx.rect(p.x - size / 2, p.y - size / 2, size, size);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** 网格背景（屏幕坐标绘制，避免缩放后线宽失真） */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  size: { w: number; h: number; dpr: number },
  viewport: { x: number; y: number; zoom: number },
  step = 24,
): void {
  const spacing = step * viewport.zoom;
  if (spacing < 6) return; // 缩得太小就不画，避免栅格噪点
  const { w, h, dpr } = size;
  const offsetX = ((((viewport.x * viewport.zoom) % spacing) + spacing) % spacing) * dpr;
  const offsetY = ((((viewport.y * viewport.zoom) % spacing) + spacing) % spacing) * dpr;
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#e9ecf1';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = offsetX; x <= w * dpr; x += spacing * dpr) {
    // 对齐到 0.5 像素保证 1px 线清晰
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, h * dpr);
  }
  for (let y = offsetY; y <= h * dpr; y += spacing * dpr) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w * dpr, Math.round(y) + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}
