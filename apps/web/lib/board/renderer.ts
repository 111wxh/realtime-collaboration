/**
 * 渲染层：两层 canvas（内容层 + 覆盖层）+ DPR 处理 + "只在脏时重绘"的 rAF 循环。
 *
 * 分层原因：
 *  - 内容层（shapes / 网格）只在图形或视口变化时重绘；
 *  - 覆盖层（选中框、控制点、框选矩形、他人光标）在光标移动时高频重绘，
 *    但它很轻，不需要把整个画布重画一遍。
 *
 * 坐标：世界坐标 ↔ 屏幕坐标的唯一换算点在这里（screenToWorld / worldToScreen）。
 */
import type { Shape } from '@collab/shared';

import type { Bounds, Point } from './hitTest';
import { getHandlePositions, getShapeBounds, HANDLE_SIZE } from './hitTest';
import { drawGrid, drawHandles, drawSelectionOutline, drawShape } from './shapes';

export interface Viewport {
  /** 世界坐标原点在屏幕上的偏移（CSS 像素） */
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/** 屏幕坐标 → 世界坐标 */
export function screenToWorld(p: Point, vp: Viewport): Point {
  return { x: (p.x - vp.x) / vp.zoom, y: (p.y - vp.y) / vp.zoom };
}

/** 世界坐标 → 屏幕坐标 */
export function worldToScreen(p: Point, vp: Viewport): Point {
  return { x: p.x * vp.zoom + vp.x, y: p.y * vp.zoom + vp.y };
}

/** 以某个屏幕点为锚缩放（滚轮缩放时锚点保持不动） */
export function zoomAt(vp: Viewport, screenPoint: Point, nextZoom: number): Viewport {
  const zoom = clampZoom(nextZoom);
  const world = screenToWorld(screenPoint, vp);
  return {
    zoom,
    x: screenPoint.x - world.x * zoom,
    y: screenPoint.y - world.y * zoom,
  };
}

export interface RemoteCursor {
  userId: string;
  displayName: string;
  color: string;
  /** 世界坐标 */
  x: number;
  y: number;
}

export interface RenderScene {
  /** 可见图形（已过滤软删除），可为任意顺序，内部按 zIndex 排 */
  shapes: Shape[];
  /** 正在绘制中的预览图形（虚线） */
  preview: Shape | null;
  selection: string[];
  /** 框选矩形（世界坐标） */
  marquee: Bounds | null;
  remoteCursors: RemoteCursor[];
  viewport: Viewport;
}

const SELECTION_COLOR = '#4c8dff';

export class BoardRenderer {
  private readonly content: CanvasRenderingContext2D;

  private readonly overlay: CanvasRenderingContext2D;

  private readonly contentCanvas: HTMLCanvasElement;

  private readonly overlayCanvas: HTMLCanvasElement;

  private width = 0;

  private height = 0;

  private dpr = 1;

  private dirtyContent = true;

  private dirtyOverlay = true;

  private frame: number | null = null;

  private disposed = false;

  private scene: RenderScene = {
    shapes: [],
    preview: null,
    selection: [],
    marquee: null,
    remoteCursors: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };

  constructor(contentCanvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement) {
    const content = contentCanvas.getContext('2d');
    const overlay = overlayCanvas.getContext('2d');
    if (!content || !overlay) throw new Error('无法获取 2D 上下文');
    this.contentCanvas = contentCanvas;
    this.overlayCanvas = overlayCanvas;
    this.content = content;
    this.overlay = overlay;
  }

  /** 视口变化 / 数据变化时调用；只标脏，重绘交给 rAF */
  update(scene: Partial<RenderScene>, options?: { content?: boolean; overlay?: boolean }): void {
    this.scene = { ...this.scene, ...scene };
    if (options?.content !== false) this.dirtyContent = true;
    if (options?.overlay !== false) this.dirtyOverlay = true;
    this.schedule();
  }

  getScene(): RenderScene {
    return this.scene;
  }

  /** 尺寸变化（ResizeObserver / 窗口缩放）：重设 DPR 缓冲并全量重绘 */
  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const dpr = typeof window === 'undefined' ? 1 : Math.max(1, window.devicePixelRatio || 1);
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    for (const canvas of [this.contentCanvas, this.overlayCanvas]) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    this.dirtyContent = true;
    this.dirtyOverlay = true;
    this.schedule();
  }

  get size(): { w: number; h: number } {
    return { w: this.width, h: this.height };
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  private schedule(): void {
    if (this.disposed || this.frame !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.flush();
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.flush();
    });
  }

  /** 立即执行一次"脏了就画"，便于测试与首帧 */
  flush(): void {
    if (this.dirtyContent) {
      this.dirtyContent = false;
      this.drawContent();
    }
    if (this.dirtyOverlay) {
      this.dirtyOverlay = false;
      this.drawOverlay();
    }
  }

  private drawContent(): void {
    const { viewport, shapes, preview } = this.scene;
    const ctx = this.content;
    const w = this.width;
    const h = this.height;
    const dpr = this.dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w * dpr, h * dpr);
    // 网格用屏幕坐标画（缩放时线宽不失真）
    drawGrid(ctx, { w, h, dpr }, viewport);

    ctx.setTransform(
      dpr * viewport.zoom,
      0,
      0,
      dpr * viewport.zoom,
      dpr * viewport.x,
      dpr * viewport.y,
    );
    const sorted = [...shapes].sort((a, b) => a.zIndex - b.zIndex);
    for (const shape of sorted) {
      drawShape(ctx, shape);
    }
    if (preview) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.globalAlpha = 0.9;
      drawShape(ctx, preview);
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawOverlay(): void {
    const { viewport, shapes, selection, marquee, remoteCursors } = this.scene;
    const ctx = this.overlay;
    const w = this.width;
    const h = this.height;
    const dpr = this.dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 选中框：单选画控制点，多选只画外框
    const selectedShapes = shapes.filter((s) => selection.includes(s.id));
    if (selectedShapes.length === 1) {
      const only = selectedShapes[0]!;
      const bounds = getShapeBounds(only);
      const screen = boundsToScreen(bounds, viewport);
      drawSelectionOutline(ctx, screen, SELECTION_COLOR);
      drawHandles(ctx, Object.values(getHandlePositions(screen)), HANDLE_SIZE, SELECTION_COLOR);
    } else if (selectedShapes.length > 1) {
      for (const shape of selectedShapes) {
        drawSelectionOutline(ctx, boundsToScreen(getShapeBounds(shape), viewport), SELECTION_COLOR);
      }
      ctx.save();
      ctx.strokeStyle = SELECTION_COLOR;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1;
      const outer = boundsToScreen(
        unionOf(selectedShapes.map((s) => getShapeBounds(s))) ?? { x: 0, y: 0, w: 0, h: 0 },
        viewport,
      );
      ctx.strokeRect(outer.x - 2, outer.y - 2, outer.w + 4, outer.h + 4);
      ctx.restore();
    }

    if (marquee) {
      const rect = boundsToScreen(marquee, viewport);
      ctx.save();
      ctx.fillStyle = 'rgba(76, 141, 255, 0.10)';
      ctx.strokeStyle = SELECTION_COLOR;
      ctx.lineWidth = 1;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);
      ctx.restore();
    }

    for (const cursor of remoteCursors) {
      drawRemoteCursor(ctx, cursor, viewport);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

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

function boundsToScreen(b: Bounds, vp: Viewport): Bounds {
  const origin = worldToScreen({ x: b.x, y: b.y }, vp);
  return { x: origin.x, y: origin.y, w: b.w * vp.zoom, h: b.h * vp.zoom };
}

/** 他人光标：小三角 + 名字牌（底色用对方的 avatarColor） */
function drawRemoteCursor(ctx: CanvasRenderingContext2D, cursor: RemoteCursor, vp: Viewport): void {
  const p = worldToScreen({ x: cursor.x, y: cursor.y }, vp);
  ctx.save();
  ctx.setLineDash([]);
  ctx.translate(p.x, p.y);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 15);
  ctx.lineTo(4.6, 11);
  ctx.lineTo(11, 10.4);
  ctx.closePath();
  ctx.fillStyle = cursor.color;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  const label = cursor.displayName || '协作者';
  ctx.font =
    '11px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  const textWidth = ctx.measureText(label).width;
  ctx.fillStyle = cursor.color;
  roundRect(ctx, 10, 12, textWidth + 12, 18, 4);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 16, 21.5);
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
