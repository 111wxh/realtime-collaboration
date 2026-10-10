/**
 * 画布基础常量与工具：工具枚举、默认样式、ID 生成。
 *
 * 样式取值与服务器 ShapeStyleSchema 的约束保持兼容（strokeWidth 0-64、fontSize 4-512）。
 */
import type { ShapeStyle, ShapeType } from '@collab/shared';

/** 工具：选择 / 平移 / 六种图元 */
export type Tool = 'select' | 'pan' | ShapeType;

/** 会"画东西"的工具（用于判断是否走绘制分支） */
export const SHAPE_TOOLS: ShapeType[] = ['rect', 'ellipse', 'line', 'arrow', 'freedraw', 'text'];

export const TOOL_LABELS: Record<Tool, string> = {
  select: '选择',
  pan: '平移',
  rect: '矩形',
  ellipse: '椭圆',
  line: '直线',
  arrow: '箭头',
  freedraw: '自由画',
  text: '文本',
};

export const DEFAULT_STYLE: Required<
  Pick<ShapeStyle, 'stroke' | 'fill' | 'strokeWidth' | 'opacity' | 'fontSize'>
> = {
  stroke: '#16181d',
  fill: 'transparent',
  strokeWidth: 2,
  opacity: 1,
  fontSize: 16,
};

/** 描边色板（第一个是默认色） */
export const STROKE_COLORS = ['#16181d', '#4c8dff', '#12a594', '#f5a524', '#e5484d'] as const;

/** 填充色板，transparent 表示不填充 */
export const FILL_COLORS = ['transparent', '#eaf1ff', '#e6f6f2', '#fff3d9', '#fdecec'] as const;

export const STROKE_WIDTHS = [1, 2, 4, 6] as const;

/** 图形最小可见尺寸（小于它视为"误点"，不创建图形） */
export const MIN_DRAW_SIZE = 2;

/** zIndex 步长与上下界（与协议 ShapeSchema 的 ±100000 对齐） */
export const Z_INDEX_STEP = 1;
export const Z_INDEX_MIN = -100_000;
export const Z_INDEX_MAX = 100_000;

export function clampZIndex(z: number): number {
  return Math.max(Z_INDEX_MIN, Math.min(Z_INDEX_MAX, Math.round(z)));
}

/**
 * UUID 生成。图形 ID 与 clientOpId 都由客户端生成（幂等键 + 乐观更新的稳定 ID）。
 * crypto.randomUUID 只在安全上下文提供，非 https/非 localhost 用随机兜底。
 */
export function newId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 是否是可以接受键盘快捷键的目标（输入框内不抢快捷键） */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as HTMLElement;
  const tag = el.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}
