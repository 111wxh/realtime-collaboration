/**
 * 命中测试与几何：包围盒、精确判定、控制点、框选、缩放。
 *
 * 全部是纯函数，坐标系为"世界坐标"（画布坐标）。屏幕坐标 → 世界坐标的换算在 renderer.ts
 * （screenToWorld），组件负责在事件入口做一次转换，这一层永远只面对世界坐标。
 *
 * 约定：所有图元的 w/h 允许为负（line/arrow 的 w/h 是相对终点的位移），
 * getShapeBounds 统一归一化成 x/y/w/h >= 0 的包围盒。
 */
import type { Shape, ShapePatch } from '@collab/shared';

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** 控制点绘制边长（屏幕像素）与命中半径（屏幕像素） */
export const HANDLE_SIZE = 8;
export const HANDLE_HIT_RADIUS = 8;

/** 点集类图元（line/arrow/freedraw）的判定容差（世界单位，调用方按 zoom 折算） */
export const DEFAULT_HIT_TOLERANCE = 6;

/** 有 points 的图元：点坐标相对图形左上角 (x, y) */
export function hasPoints(shape: Shape): boolean {
  const pts = shape.data.points;
  return (
    (shape.type === 'line' || shape.type === 'arrow' || shape.type === 'freedraw') &&
    Array.isArray(pts) &&
    pts.length > 0
  );
}

/** 相对点 → 绝对世界坐标 */
export function absolutePoint(shape: Shape, rel: Point): Point {
  return { x: shape.x + rel.x, y: shape.y + rel.y };
}

/** 图元绝对点集（无 points 的图元返回空数组） */
export function absolutePoints(shape: Shape): Point[] {
  const pts = shape.data.points ?? [];
  return pts.map((p) => ({ x: shape.x + p.x, y: shape.y + p.y }));
}

/** 归一化包围盒：点集图元用点集算，其余用 x/y/w/h */
export function getShapeBounds(shape: Shape): Bounds {
  if (hasPoints(shape)) {
    const pts = absolutePoints(shape);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX)) return { x: shape.x, y: shape.y, w: 0, h: 0 };
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return {
    x: Math.min(shape.x, shape.x + shape.w),
    y: Math.min(shape.y, shape.y + shape.h),
    w: Math.abs(shape.w),
    h: Math.abs(shape.h),
  };
}

/** 多个包围盒的并集 */
export function unionBounds(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of list) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function pointInBounds(p: Point, b: Bounds): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

export function boundsFromPoints(a: Point, b: Point): Bounds {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** 点到线段距离 */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 点到折线的最短距离 */
export function distanceToPolyline(p: Point, pts: Point[]): number {
  if (pts.length === 0) return Infinity;
  const first = pts[0]!;
  if (pts.length === 1) return Math.hypot(p.x - first.x, p.y - first.y);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const d = distanceToSegment(p, a, b);
    if (d < best) best = d;
  }
  return best;
}

/**
 * 单图形命中判定（世界坐标）。
 * - rect / text：包围盒内即命中（文本没有透明区域，用包围盒最直观）；
 * - ellipse：椭圆方程精确判定（角落在椭圆外不算命中）；
 * - line / arrow / freedraw：点到折线距离 <= 容差 + 线宽/2。
 */
export function hitTestShape(shape: Shape, p: Point, tolerance = DEFAULT_HIT_TOLERANCE): boolean {
  const bounds = getShapeBounds(shape);
  const strokePad = Math.max(0, shape.style.strokeWidth ?? 2) / 2;
  const tol = tolerance + strokePad;

  if (hasPoints(shape)) {
    const pts = absolutePoints(shape);
    if (shape.type === 'line' || shape.type === 'arrow') {
      return distanceToPolyline(p, pts) <= tol;
    }
    // freedraw：先快速排除包围盒外的点
    if (
      p.x < bounds.x - tol ||
      p.x > bounds.x + bounds.w + tol ||
      p.y < bounds.y - tol ||
      p.y > bounds.y + bounds.h + tol
    ) {
      return false;
    }
    return distanceToPolyline(p, pts) <= tol;
  }

  if (shape.type === 'ellipse') {
    const rx = Math.max(bounds.w / 2, 1e-6);
    const ry = Math.max(bounds.h / 2, 1e-6);
    const cx = bounds.x + rx;
    const cy = bounds.y + ry;
    const nx = (p.x - cx) / (rx + tol);
    const ny = (p.y - cy) / (ry + tol);
    return nx * nx + ny * ny <= 1;
  }

  return (
    p.x >= bounds.x - tol &&
    p.x <= bounds.x + bounds.w + tol &&
    p.y >= bounds.y - tol &&
    p.y <= bounds.y + bounds.h + tol
  );
}

export interface ShapeHit {
  shape: Shape;
  /** 命中的图形与 id 一起返回，省得调用方再查一次 */
  shapeId: string;
}

/**
 * 取命中的最上层图形（zIndex 大者优先，同 zIndex 用 id 兜底保证确定性）。
 * 传入的 shapes 需要是"可见图形"（已过滤软删除）。
 */
export function hitTestTopmost(
  shapes: Shape[],
  p: Point,
  tolerance = DEFAULT_HIT_TOLERANCE,
): ShapeHit | null {
  const sorted = [...shapes].sort((a, b) =>
    a.zIndex === b.zIndex ? (a.id < b.id ? 1 : -1) : b.zIndex - a.zIndex,
  );
  for (const shape of sorted) {
    if (hitTestShape(shape, p, tolerance)) return { shape, shapeId: shape.id };
  }
  return null;
}

/** 框选：包围盒相交即入选（比"完全包含"更好用，与主流白板一致） */
export function shapesInRect(shapes: Shape[], rect: Bounds): Shape[] {
  return shapes.filter((s) => boundsIntersect(getShapeBounds(s), rect));
}

/**
 * 控制点位置：包围盒 8 个方位。
 * 传入世界坐标包围盒，返回世界坐标点位；zoom 只影响绘制与命中半径（由调用方处理）。
 */
export function getHandlePositions(b: Bounds): Record<ResizeHandle, Point> {
  const midX = b.x + b.w / 2;
  const midY = b.y + b.h / 2;
  const right = b.x + b.w;
  const bottom = b.y + b.h;
  return {
    nw: { x: b.x, y: b.y },
    n: { x: midX, y: b.y },
    ne: { x: right, y: b.y },
    e: { x: right, y: midY },
    se: { x: right, y: bottom },
    s: { x: midX, y: bottom },
    sw: { x: b.x, y: bottom },
    w: { x: b.x, y: midY },
  };
}

/**
 * 命中控制点。tolerance 由调用方按 zoom 折算（屏幕半径 / zoom）。
 * 只有单选框要控制点，多选时返回 null。
 */
export function hitTestHandle(bounds: Bounds, p: Point, tolerance: number): ResizeHandle | null {
  const positions = getHandlePositions(bounds);
  for (const handle of RESIZE_HANDLES) {
    const pos = positions[handle];
    if (Math.abs(p.x - pos.x) <= tolerance && Math.abs(p.y - pos.y) <= tolerance) {
      return handle;
    }
  }
  return null;
}

/** 缩放时各 handle 对包围盒哪条边生效 */
const HANDLE_EDGES: Record<
  ResizeHandle,
  { left: boolean; right: boolean; top: boolean; bottom: boolean }
> = {
  nw: { left: true, right: false, top: true, bottom: false },
  n: { left: false, right: false, top: true, bottom: false },
  ne: { left: false, right: true, top: true, bottom: false },
  e: { left: false, right: true, top: false, bottom: false },
  se: { left: false, right: true, top: false, bottom: true },
  s: { left: false, right: false, top: false, bottom: true },
  sw: { left: true, right: false, top: false, bottom: true },
  w: { left: true, right: false, top: false, bottom: false },
};

/**
 * 拖控制点缩放：返回 ShapePatch。
 *
 * - 点集图元（line/arrow/freedraw）：点按新旧包围盒比例映射，天然支持负向拖拽；
 * - 其余图元：直接给归一化后的 x/y/w/h；
 * - 最小尺寸 0：直线可以压成一条水平/垂直线（点集比例为 0 时按 1 处理避免除零）。
 */
export function resizeShape(shape: Shape, handle: ResizeHandle, p: Point): ShapePatch {
  const b = getShapeBounds(shape);
  const edges = HANDLE_EDGES[handle];
  let left = b.x;
  let top = b.y;
  let right = b.x + b.w;
  let bottom = b.y + b.h;

  if (edges.left) left = p.x;
  if (edges.right) right = p.x;
  if (edges.top) top = p.y;
  if (edges.bottom) bottom = p.y;

  let x = Math.min(left, right);
  let y = Math.min(top, bottom);
  let w = Math.abs(right - left);
  let h = Math.abs(bottom - top);

  if (hasPoints(shape)) {
    const scaleX = b.w > 0 ? w / b.w : 1;
    const scaleY = b.h > 0 ? h / b.h : 1;
    const pts = shape.data.points ?? [];
    const nextPoints = pts.map((rel) => ({
      x: b.w > 0 ? rel.x * scaleX : 0,
      y: b.h > 0 ? rel.y * scaleY : 0,
    }));
    // 反向拖拽时点集顺序会翻转，包围盒随之变为正尺寸，这里重算一次保证包围盒 = 点集范围
    const abs = nextPoints.map((rel) => ({ x: x + rel.x, y: y + rel.y }));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const q of abs) {
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x);
      maxY = Math.max(maxY, q.y);
    }
    x = minX;
    y = minY;
    w = Math.max(maxX - minX, 0);
    h = Math.max(maxY - minY, 0);
    return {
      x,
      y,
      w,
      h,
      data: { ...shape.data, points: nextPoints },
    };
  }

  return { x, y, w, h };
}

/**
 * 平移一组图形的 patch：点集坐标是相对坐标，所以只改 x/y。
 */
export function translateShapes(
  shapes: Shape[],
  dx: number,
  dy: number,
): { shapeId: string; patch: ShapePatch }[] {
  return shapes.map((s) => ({
    shapeId: s.id,
    patch: { x: round2(s.x + dx), y: round2(s.y + dy) },
  }));
}

/** 坐标保留 2 位小数：避免浮点数把 patch 变得没法比较（也让测试更稳） */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
