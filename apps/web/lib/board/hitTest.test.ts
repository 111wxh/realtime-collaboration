/**
 * 命中测试与几何的单测：包围盒、精确判定、控制点、框选、缩放。
 */
import { describe, expect, it } from 'vitest';

import { BOARD_ID, makeShape } from './testFixtures';
import {
  absolutePoints,
  boundsFromPoints,
  distanceToSegment,
  getHandlePositions,
  getShapeBounds,
  hitTestHandle,
  hitTestShape,
  hitTestTopmost,
  pointInBounds,
  resizeShape,
  shapesInRect,
  translateShapes,
  unionBounds,
} from './hitTest';

describe('getShapeBounds', () => {
  it('rect 的负宽高会被归一化', () => {
    const shape = makeShape({ type: 'rect', x: 100, y: 80, w: -40, h: -30 });
    expect(getShapeBounds(shape)).toEqual({ x: 60, y: 50, w: 40, h: 30 });
  });

  it('line 用点集算包围盒（x/y 是起点，w/h 是位移）', () => {
    const shape = makeShape({
      type: 'line',
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      data: {
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 50 },
        ],
      },
    });
    expect(getShapeBounds(shape)).toEqual({ x: 10, y: 20, w: 100, h: 50 });
  });

  it('反向拖出来的 line 包围盒仍然为正', () => {
    const shape = makeShape({
      type: 'line',
      x: 100,
      y: 100,
      w: -80,
      h: -60,
      data: {
        points: [
          { x: 0, y: 0 },
          { x: -80, y: -60 },
        ],
      },
    });
    expect(getShapeBounds(shape)).toEqual({ x: 20, y: 40, w: 80, h: 60 });
  });

  it('freedraw 的包围盒由点集决定', () => {
    const shape = makeShape({
      type: 'freedraw',
      x: 5,
      y: 5,
      w: 0,
      h: 0,
      data: {
        points: [
          { x: 0, y: 0 },
          { x: 30, y: 10 },
          { x: 12, y: 40 },
        ],
      },
    });
    expect(getShapeBounds(shape)).toEqual({ x: 5, y: 5, w: 30, h: 40 });
  });
});

describe('hitTestShape', () => {
  const rect = makeShape({ type: 'rect', x: 0, y: 0, w: 100, h: 60 });

  it('矩形内部命中（含只碰边框的容差范围）', () => {
    expect(hitTestShape(rect, { x: 50, y: 30 })).toBe(true);
    expect(hitTestShape(rect, { x: 0, y: 0 })).toBe(true);
    expect(hitTestShape(rect, { x: 100, y: 60 })).toBe(true);
    expect(hitTestShape(rect, { x: 100 + 7, y: 30 }, 0)).toBe(false);
  });

  it('椭圆四角在椭圆外（精确判定，不是包围盒）', () => {
    const ellipse = makeShape({ type: 'ellipse', x: 0, y: 0, w: 100, h: 50 });
    expect(hitTestShape(ellipse, { x: 50, y: 25 })).toBe(true); // 圆心
    expect(hitTestShape(ellipse, { x: 99, y: 1 }, 0)).toBe(false); // 右上角在椭圆外
    expect(hitTestShape(ellipse, { x: 1, y: 49 }, 0)).toBe(false); // 左下角
  });

  it('线段按点到线段距离判定', () => {
    const line = makeShape({
      type: 'line',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      data: {
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
      },
    });
    expect(hitTestShape(line, { x: 50, y: 50 }, 1)).toBe(true);
    expect(hitTestShape(line, { x: 50, y: 70 }, 1)).toBe(false);
    expect(hitTestShape(line, { x: 50, y: 55 }, 6)).toBe(true);
    // 端点之外不命中
    expect(hitTestShape(line, { x: 130, y: 130 }, 1)).toBe(false);
  });

  it('自由画笔按折线判定，空白处不命中', () => {
    const stroke = makeShape({
      type: 'freedraw',
      x: 0,
      y: 0,
      data: {
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      },
    });
    expect(hitTestShape(stroke, { x: 50, y: 1 }, 1)).toBe(true);
    expect(hitTestShape(stroke, { x: 50, y: 40 }, 1)).toBe(false);
  });

  it('文本按包围盒判定', () => {
    const text = makeShape({ type: 'text', x: 10, y: 10, w: 80, h: 20, data: { text: '你好' } });
    expect(hitTestShape(text, { x: 15, y: 15 }, 0)).toBe(true);
    expect(hitTestShape(text, { x: 95, y: 15 }, 0)).toBe(false);
  });

  it('线宽会加到判定容差里', () => {
    const thick = makeShape({
      type: 'line',
      x: 0,
      y: 0,
      w: 100,
      h: 0,
      style: { stroke: '#000', strokeWidth: 20 },
      data: {
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      },
    });
    expect(hitTestShape(thick, { x: 50, y: 8 }, 0)).toBe(true);
    expect(hitTestShape(thick, { x: 50, y: 15 }, 0)).toBe(false);
  });
});

describe('hitTestTopmost', () => {
  it('取 zIndex 最大的那个', () => {
    const bottom = makeShape({ type: 'rect', x: 0, y: 0, w: 100, h: 100, zIndex: 1 });
    const top = makeShape({ type: 'rect', x: 0, y: 0, w: 100, h: 100, zIndex: 5 });
    const hit = hitTestTopmost([bottom, top], { x: 10, y: 10 });
    expect(hit?.shapeId).toBe(top.id);
  });

  it('全都没命中时返回 null', () => {
    const shape = makeShape({ type: 'rect', x: 0, y: 0, w: 10, h: 10 });
    expect(hitTestTopmost([shape], { x: 500, y: 500 }, 0)).toBeNull();
  });
});

describe('控制点与缩放', () => {
  const rect = makeShape({ type: 'rect', x: 0, y: 0, w: 100, h: 100 });

  it('8 个控制点的位置正确', () => {
    const positions = getHandlePositions({ x: 0, y: 0, w: 100, h: 100 });
    expect(positions.nw).toEqual({ x: 0, y: 0 });
    expect(positions.se).toEqual({ x: 100, y: 100 });
    expect(positions.n).toEqual({ x: 50, y: 0 });
    expect(positions.w).toEqual({ x: 0, y: 50 });
  });

  it('命中控制点（按容差）', () => {
    const bounds = getShapeBounds(rect);
    expect(hitTestHandle(bounds, { x: 101, y: 99 }, 8)).toBe('se');
    expect(hitTestHandle(bounds, { x: 0, y: 0 }, 8)).toBe('nw');
    expect(hitTestHandle(bounds, { x: 50, y: 50 }, 8)).toBeNull();
  });

  it('拖右下角只改宽高', () => {
    const patch = resizeShape(rect, 'se', { x: 150, y: 120 });
    expect(patch).toEqual({ x: 0, y: 0, w: 150, h: 120 });
  });

  it('拖左上角会同时移动原点并缩小尺寸', () => {
    const patch = resizeShape(rect, 'nw', { x: 20, y: 10 });
    expect(patch).toEqual({ x: 20, y: 10, w: 80, h: 90 });
  });

  it('拖过对边会翻转（包围盒仍然为正）', () => {
    const patch = resizeShape(rect, 'e', { x: -40, y: 50 });
    expect(patch).toEqual({ x: -40, y: 0, w: 40, h: 100 });
  });

  it('缩放直线时按比例缩放点集', () => {
    const line = makeShape({
      type: 'line',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      data: {
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
      },
    });
    const patch = resizeShape(line, 'se', { x: 200, y: 50 });
    expect(patch.x).toBe(0);
    expect(patch.y).toBe(0);
    expect(patch.w).toBe(200);
    expect(patch.h).toBe(50);
    expect(patch.data?.points).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 50 },
    ]);
  });

  it('缩放自由画笔保持包围盒与点集一致', () => {
    const stroke = makeShape({
      type: 'freedraw',
      x: 10,
      y: 10,
      data: {
        points: [
          { x: 0, y: 0 },
          { x: 20, y: 40 },
        ],
      },
    });
    const patch = resizeShape(stroke, 'se', { x: 10 + 40, y: 10 + 20 });
    expect(patch.data?.points).toEqual([
      { x: 0, y: 0 },
      { x: 40, y: 20 },
    ]);
    const scaled = { ...stroke, ...patch, data: patch.data ?? stroke.data };
    expect(getShapeBounds(scaled)).toEqual({ x: 10, y: 10, w: 40, h: 20 });
  });
});

describe('框选与平移', () => {
  it('框选取包围盒相交的图形', () => {
    const inside = makeShape({ type: 'rect', x: 10, y: 10, w: 20, h: 20 });
    const partial = makeShape({ type: 'rect', x: 90, y: 10, w: 40, h: 20 });
    const far = makeShape({ type: 'rect', x: 400, y: 400, w: 20, h: 20 });
    const rect = boundsFromPoints({ x: 0, y: 0 }, { x: 100, y: 100 });
    const hit = shapesInRect([inside, partial, far], rect).map((s) => s.id);
    expect(hit).toContain(inside.id);
    expect(hit).toContain(partial.id);
    expect(hit).not.toContain(far.id);
  });

  it('平移只改 x/y（点集是相对坐标）', () => {
    const line = makeShape({
      type: 'line',
      x: 0,
      y: 0,
      w: 50,
      h: 0,
      data: {
        points: [
          { x: 0, y: 0 },
          { x: 50, y: 0 },
        ],
      },
    });
    const [patch] = translateShapes([line], 10, -5);
    expect(patch?.patch).toEqual({ x: 10, y: -5 });
  });

  it('包围盒并集与点包含判断', () => {
    const union = unionBounds([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 20, y: 5, w: 10, h: 10 },
    ]);
    expect(union).toEqual({ x: 0, y: 0, w: 30, h: 15 });
    expect(pointInBounds({ x: 5, y: 5 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(true);
    expect(pointInBounds({ x: 15, y: 5 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(false);
  });
});

describe('几何工具', () => {
  it('点到线段距离', () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3);
    expect(distanceToSegment({ x: -4, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(4);
  });

  it('绝对点集是相对点 + 图形原点', () => {
    const shape = makeShape({
      type: 'freedraw',
      x: 7,
      y: 9,
      data: { points: [{ x: 1, y: 1 }] },
    });
    expect(absolutePoints(shape)).toEqual([{ x: 8, y: 10 }]);
  });

  it('boardId 由调用方给定，夹具保持一致', () => {
    expect(makeShape({ type: 'rect' }).boardId).toBe(BOARD_ID);
  });
});
