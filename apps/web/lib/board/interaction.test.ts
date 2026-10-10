/**
 * 交互状态机的单测：绘制 / 选中 / 拖拽 / 缩放 / 框选 / 平移 / 文本 / 快捷键。
 * 状态机是纯函数，所以这里完全不需要 DOM。
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_STYLE } from './defaults';
import type {
  HitTarget,
  InteractionCommand,
  InteractionContext,
  InteractionEvent,
  InteractionState,
  PointerInfo,
} from './interaction';
import {
  getMarqueeRect,
  getPreviewShape,
  initialInteractionState,
  reduceInteraction,
} from './interaction';
import { getShapeBounds } from './hitTest';
import { BOARD_ID, makeShape, shapeMap, testId } from './testFixtures';

const BOARD = BOARD_ID;

function context(overrides: Partial<InteractionContext> = {}): InteractionContext {
  return {
    tool: 'select',
    shapes: {},
    selection: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    boardId: BOARD,
    createdBy: null,
    style: { ...DEFAULT_STYLE },
    nextZIndex: 0,
    ...overrides,
  };
}

/** 指针信息：只写关心的字段，其余取默认值（左键、无修饰键、世界原点） */
function pointer(overrides: Partial<PointerInfo> = {}): PointerInfo {
  return {
    point: { x: 0, y: 0 },
    shift: false,
    alt: false,
    ctrl: false,
    button: 0,
    space: false,
    ...overrides,
  };
}

/** 跑一串事件，返回最终状态与全部命令 */
function run(
  events: InteractionEvent[],
  ctx: InteractionContext,
  initial: InteractionState = initialInteractionState(),
): { state: InteractionState; commands: InteractionCommand[] } {
  let state = initial;
  const commands: InteractionCommand[] = [];
  for (const event of events) {
    const result = reduceInteraction(state, event, ctx);
    state = result.state;
    commands.push(...result.commands);
  }
  return { state, commands };
}

function kinds(commands: InteractionCommand[]): string[] {
  return commands.map((command) => command.kind);
}

function first<T extends InteractionCommand['kind']>(
  commands: InteractionCommand[],
  kind: T,
): Extract<InteractionCommand, { kind: T }> | undefined {
  return commands.find((command) => command.kind === kind) as
    Extract<InteractionCommand, { kind: T }> | undefined;
}

/** 最后一条某类命令（"点击空白先清空选中、再框选赋值"这类序列要用它） */
function last<T extends InteractionCommand['kind']>(
  commands: InteractionCommand[],
  kind: T,
): Extract<InteractionCommand, { kind: T }> | undefined {
  for (let i = commands.length - 1; i >= 0; i -= 1) {
    const command = commands[i]!;
    if (command.kind === kind) return command as Extract<InteractionCommand, { kind: T }>;
  }
  return undefined;
}

const EMPTY: HitTarget = { kind: 'none' };

describe('绘制', () => {
  it('拖出矩形：创建图形 + 选中 + 回到选择工具', () => {
    const ctx = context({ tool: 'rect', nextZIndex: 3 });
    const { state, commands } = run(
      [
        { type: 'pointer-down', pointer: pointer({ point: { x: 10, y: 20 } }), target: EMPTY },
        { type: 'pointer-move', pointer: pointer({ point: { x: 60, y: 70 } }) },
        { type: 'pointer-up', pointer: pointer({ point: { x: 110, y: 90 } }) },
      ],
      ctx,
    );

    expect(state.kind).toBe('idle');
    expect(kinds(commands)).toEqual(['create-shape', 'select', 'set-tool']);
    const created = first(commands, 'create-shape')!.shape;
    expect(created.type).toBe('rect');
    expect({ x: created.x, y: created.y, w: created.w, h: created.h }).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 70,
    });
    expect(created.boardId).toBe(BOARD);
    expect(created.zIndex).toBe(3);
    expect(first(commands, 'set-tool')!.tool).toBe('select');
    expect(first(commands, 'select')!.ids).toEqual([created.id]);
  });

  it('反向拖拽也得到正尺寸包围盒', () => {
    const ctx = context({ tool: 'ellipse' });
    const { commands } = run(
      [
        { type: 'pointer-down', pointer: pointer({ point: { x: 100, y: 100 } }), target: EMPTY },
        { type: 'pointer-up', pointer: pointer({ point: { x: 40, y: 30 } }) },
      ],
      ctx,
    );
    const shape = first(commands, 'create-shape')!.shape;
    expect({ x: shape.x, y: shape.y, w: shape.w, h: shape.h }).toEqual({
      x: 40,
      y: 30,
      w: 60,
      h: 70,
    });
  });

  it('直线用起点 + 位移表示，并带两个相对点', () => {
    const ctx = context({ tool: 'line' });
    const { commands } = run(
      [
        { type: 'pointer-down', pointer: pointer({ point: { x: 10, y: 10 } }), target: EMPTY },
        { type: 'pointer-up', pointer: pointer({ point: { x: 90, y: 40 } }) },
      ],
      ctx,
    );
    const shape = first(commands, 'create-shape')!.shape;
    expect({ x: shape.x, y: shape.y, w: shape.w, h: shape.h }).toEqual({
      x: 10,
      y: 10,
      w: 80,
      h: 30,
    });
    expect(shape.data.points).toEqual([
      { x: 0, y: 0 },
      { x: 80, y: 30 },
    ]);
  });

  it('拖拽位移太小视为误点，不创建图形', () => {
    const ctx = context({ tool: 'rect' });
    const { commands, state } = run(
      [
        { type: 'pointer-down', pointer: pointer({ point: { x: 10, y: 10 } }), target: EMPTY },
        { type: 'pointer-up', pointer: pointer({ point: { x: 11, y: 10 } }) },
      ],
      ctx,
    );
    expect(state.kind).toBe('idle');
    expect(commands).toHaveLength(0);
  });

  it('自由画笔累积轨迹（过密的点会被过滤）', () => {
    const ctx = context({ tool: 'freedraw' });
    const { commands } = run(
      [
        { type: 'pointer-down', pointer: pointer({ point: { x: 0, y: 0 } }), target: EMPTY },
        { type: 'pointer-move', pointer: pointer({ point: { x: 0.2, y: 0.2 } }) }, // 太近，忽略
        { type: 'pointer-move', pointer: pointer({ point: { x: 20, y: 0 } }) },
        { type: 'pointer-move', pointer: pointer({ point: { x: 20, y: 20 } }) },
        { type: 'pointer-up', pointer: pointer({ point: { x: 20, y: 20 } }) },
      ],
      ctx,
    );
    const shape = first(commands, 'create-shape')!.shape;
    expect(shape.type).toBe('freedraw');
    expect(shape.data.points).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
    ]);
    expect(getShapeBounds(shape)).toEqual({ x: 0, y: 0, w: 20, h: 20 });
  });

  it('绘制过程中的预览图形可直接用于渲染', () => {
    const ctx = context({ tool: 'rect' });
    const result = reduceInteraction(
      initialInteractionState(),
      { type: 'pointer-down', pointer: pointer({ point: { x: 5, y: 5 } }), target: EMPTY },
      ctx,
    );
    const moved = reduceInteraction(
      result.state,
      { type: 'pointer-move', pointer: pointer({ point: { x: 25, y: 15 } }) },
      ctx,
    );
    const preview = getPreviewShape(moved.state, ctx);
    expect(preview?.type).toBe('rect');
    expect({ w: preview?.w, h: preview?.h }).toEqual({ w: 20, h: 10 });
  });

  it('Esc 取消绘制', () => {
    const ctx = context({ tool: 'rect' });
    const { state, commands } = run(
      [
        { type: 'pointer-down', pointer: pointer({ point: { x: 5, y: 5 } }), target: EMPTY },
        { type: 'pointer-move', pointer: pointer({ point: { x: 60, y: 60 } }) },
        { type: 'key-down', key: 'Escape', shift: false, ctrl: false, meta: false },
      ],
      ctx,
    );
    expect(state.kind).toBe('idle');
    expect(commands).toHaveLength(0);
  });
});

describe('选中与拖拽', () => {
  const rect = makeShape({ type: 'rect', x: 0, y: 0, w: 100, h: 100 });
  const other = makeShape({ type: 'rect', x: 200, y: 200, w: 50, h: 50 });
  const ctx = context({ shapes: shapeMap(rect, other) });

  it('点击空白处取消选中并进入框选', () => {
    const { state, commands } = run(
      [
        {
          type: 'pointer-down',
          pointer: pointer({ point: { x: 500, y: 500 } }),
          target: EMPTY,
        },
      ],
      { ...ctx, selection: [rect.id] },
    );
    expect(state.kind).toBe('marquee');
    expect(first(commands, 'select')!.ids).toEqual([]);
  });

  it('点击图形：先选中再拖动，抬手提交一次 update（含位移）', () => {
    const { state, commands } = run(
      [
        {
          type: 'pointer-down',
          pointer: pointer({ point: { x: 50, y: 50 } }),
          target: { kind: 'shape', shapeId: rect.id },
        },
        { type: 'pointer-move', pointer: pointer({ point: { x: 70, y: 40 } }) },
        { type: 'pointer-up', pointer: pointer({ point: { x: 70, y: 40 } }) },
      ],
      ctx,
    );
    expect(state.kind).toBe('idle');
    expect(first(commands, 'select')!.ids).toEqual([rect.id]);
    const live = commands.filter((c) => c.kind === 'update-shapes' && c.mode === 'live');
    expect(live.length).toBeGreaterThan(0);
    const commit = commands.find((c) => c.kind === 'update-shapes' && c.mode === 'commit');
    expect(commit).toBeDefined();
    if (commit?.kind === 'update-shapes') {
      expect(commit.patches).toEqual([{ shapeId: rect.id, patch: { x: 20, y: -10 } }]);
      expect(commit.label).toBe('移动图形');
    }
  });

  it('微小抖动不产生提交（按 zoom 折算阈值）', () => {
    const { commands } = run(
      [
        {
          type: 'pointer-down',
          pointer: pointer({ point: { x: 50, y: 50 } }),
          target: { kind: 'shape', shapeId: rect.id },
        },
        { type: 'pointer-move', pointer: pointer({ point: { x: 50.5, y: 50.5 } }) },
        { type: 'pointer-up', pointer: pointer({ point: { x: 50.5, y: 50.5 } }) },
      ],
      ctx,
    );
    expect(commands.some((c) => c.kind === 'update-shapes')).toBe(false);
  });

  it('多选拖动一次提交多个 patch（走 batch）', () => {
    const { commands } = run(
      [
        {
          type: 'pointer-down',
          pointer: pointer({ point: { x: 50, y: 50 } }),
          target: { kind: 'shape', shapeId: rect.id },
        },
        { type: 'pointer-move', pointer: pointer({ point: { x: 60, y: 60 } }) },
        { type: 'pointer-up', pointer: pointer({ point: { x: 60, y: 60 } }) },
      ],
      { ...ctx, selection: [rect.id, other.id] },
    );
    const commit = commands.find((c) => c.kind === 'update-shapes' && c.mode === 'commit');
    expect(commit?.kind === 'update-shapes' ? commit.patches.length : 0).toBe(2);
  });

  it('Shift 点击是加选 / 减选，不进入拖拽', () => {
    const { state, commands } = run(
      [
        {
          type: 'pointer-down',
          pointer: pointer({ point: { x: 50, y: 50 }, shift: true }),
          target: { kind: 'shape', shapeId: rect.id },
        },
      ],
      { ...ctx, selection: [other.id] },
    );
    expect(state.kind).toBe('idle');
    expect(first(commands, 'select')!.ids.sort()).toEqual([rect.id, other.id].sort());

    const remove = run(
      [
        {
          type: 'pointer-down',
          pointer: pointer({ point: { x: 50, y: 50 }, shift: true }),
          target: { kind: 'shape', shapeId: rect.id },
        },
      ],
      { ...ctx, selection: [rect.id, other.id] },
    );
    expect(first(remove.commands, 'select')!.ids).toEqual([other.id]);
  });

  it('框选抬手选中矩形内的图形（Shift 为并集）', () => {
    const { commands } = run(
      [
        {
          type: 'pointer-down',
          pointer: pointer({ point: { x: -10, y: -10 } }),
          target: EMPTY,
        },
        { type: 'pointer-move', pointer: pointer({ point: { x: 120, y: 120 } }) },
        { type: 'pointer-up', pointer: pointer({ point: { x: 120, y: 120 } }) },
      ],
      ctx,
    );
    // 第一条 select 是"点空白清空选中"，最终结果看最后一条
    expect(last(commands, 'select')!.ids).toEqual([rect.id]);
  });

  it('拖拽中按 Esc 回到原位（只改本地预览）', () => {
    const { commands } = run(
      [
        {
          type: 'pointer-down',
          pointer: pointer({ point: { x: 50, y: 50 } }),
          target: { kind: 'shape', shapeId: rect.id },
        },
        { type: 'pointer-move', pointer: pointer({ point: { x: 120, y: 50 } }) },
        { type: 'key-down', key: 'Escape', shift: false, ctrl: false, meta: false },
      ],
      ctx,
    );
    const restore = commands[commands.length - 1];
    expect(restore?.kind === 'update-shapes' ? restore.mode : null).toBe('live');
    expect(restore?.kind === 'update-shapes' ? restore.patches : []).toEqual([
      { shapeId: rect.id, patch: { x: 0, y: 0 } },
    ]);
    expect(commands.some((c) => c.kind === 'update-shapes' && c.mode === 'commit')).toBe(false);
  });
});

describe('缩放控制点', () => {
  const rect = makeShape({ type: 'rect', x: 0, y: 0, w: 100, h: 100 });
  const ctx = context({ shapes: shapeMap(rect), selection: [rect.id] });

  it('拖右下控制点：live 预览 + 抬手提交', () => {
    const { state, commands } = run(
      [
        {
          type: 'pointer-down',
          pointer: pointer({ point: { x: 100, y: 100 } }),
          target: { kind: 'handle', shapeId: rect.id, handle: 'se' },
        },
        { type: 'pointer-move', pointer: pointer({ point: { x: 150, y: 130 } }) },
        { type: 'pointer-up', pointer: pointer({ point: { x: 150, y: 130 } }) },
      ],
      ctx,
    );
    expect(state.kind).toBe('idle');
    const commit = commands.find((c) => c.kind === 'update-shapes' && c.mode === 'commit');
    expect(commit?.kind === 'update-shapes' ? commit.patches : []).toEqual([
      { shapeId: rect.id, patch: { x: 0, y: 0, w: 150, h: 130 } },
    ]);
    expect(commit?.kind === 'update-shapes' ? commit.label : '').toBe('缩放图形');
  });

  it('Esc 取消缩放：回填原始几何', () => {
    const { commands } = run(
      [
        {
          type: 'pointer-down',
          pointer: pointer({ point: { x: 100, y: 100 } }),
          target: { kind: 'handle', shapeId: rect.id, handle: 'se' },
        },
        { type: 'pointer-move', pointer: pointer({ point: { x: 400, y: 400 } }) },
        { type: 'key-down', key: 'Escape', shift: false, ctrl: false, meta: false },
      ],
      ctx,
    );
    const restore = commands[commands.length - 1];
    // 回填的是原始几何（rect 的点集为空，data 会一并回填）
    expect(restore?.kind === 'update-shapes' ? restore.patches[0]?.patch : undefined).toMatchObject(
      {
        x: 0,
        y: 0,
        w: 100,
        h: 100,
      },
    );
  });
});

describe('框选辅助与平移', () => {
  it('框选矩形可从状态机取出（供渲染层画）', () => {
    const ctx = context();
    const down = reduceInteraction(
      initialInteractionState(),
      { type: 'pointer-down', pointer: pointer({ point: { x: 10, y: 10 } }), target: EMPTY },
      ctx,
    );
    const moved = reduceInteraction(
      down.state,
      { type: 'pointer-move', pointer: pointer({ point: { x: 30, y: 5 } }) },
      ctx,
    );
    expect(getMarqueeRect(moved.state)).toEqual({ x: 10, y: 5, w: 20, h: 5 });
    expect(getMarqueeRect(initialInteractionState())).toBeNull();
  });

  it('中键平移：视口跟随位移', () => {
    const ctx = context({ viewport: { x: 100, y: 50, zoom: 2 } });
    const { state, commands } = run(
      [
        {
          type: 'pointer-down',
          pointer: pointer({ point: { x: 10, y: 10 }, button: 1 }),
          target: EMPTY,
        },
        { type: 'pointer-move', pointer: pointer({ point: { x: 30, y: 40 }, button: 1 }) },
        { type: 'pointer-up', pointer: pointer({ point: { x: 30, y: 40 }, button: 1 }) },
      ],
      ctx,
    );
    expect(state.kind).toBe('idle');
    const viewport = first(commands, 'set-viewport')!.viewport;
    expect(viewport).toEqual({ x: 120, y: 80, zoom: 2 });
  });

  it('平移工具 / 空格也能平移，且不进入框选', () => {
    const cases: { ctx: InteractionContext; space: boolean }[] = [
      { ctx: context({ tool: 'pan' }), space: false },
      { ctx: context({ tool: 'select' }), space: true },
    ];
    for (const item of cases) {
      const { state } = run(
        [
          {
            type: 'pointer-down',
            pointer: pointer({ point: { x: 10, y: 10 }, space: item.space }),
            target: EMPTY,
          },
        ],
        item.ctx,
      );
      expect(state.kind).toBe('panning');
    }
  });
});

describe('文本与快捷键', () => {
  it('文本工具点击空白处直接开编辑器（新建）', () => {
    const ctx = context({ tool: 'text' });
    const { commands } = run(
      [{ type: 'pointer-down', pointer: pointer({ point: { x: 42, y: 24 } }), target: EMPTY }],
      ctx,
    );
    const open = first(commands, 'open-text-editor')!;
    expect(open.shapeId).toBeNull();
    expect(open.at).toEqual({ x: 42, y: 24 });
    expect(open.initial).toBe('');
  });

  it('双击文本图形进入编辑（带原有内容）', () => {
    const text = makeShape({ type: 'text', x: 10, y: 10, w: 60, h: 24, data: { text: '你好' } });
    const ctx = context({ shapes: shapeMap(text) });
    const { commands } = run(
      [
        {
          type: 'double-click',
          pointer: pointer({ point: { x: 20, y: 20 } }),
          target: { kind: 'shape', shapeId: text.id },
        },
      ],
      ctx,
    );
    const open = first(commands, 'open-text-editor')!;
    expect(open.shapeId).toBe(text.id);
    expect(open.initial).toBe('你好');
  });

  it('双击非文本图形不做事（第一版不做形状内联编辑）', () => {
    const rect = makeShape({ type: 'rect' });
    const ctx = context({ shapes: shapeMap(rect) });
    const { commands } = run(
      [
        {
          type: 'double-click',
          pointer: pointer({ point: { x: 20, y: 20 } }),
          target: { kind: 'shape', shapeId: rect.id },
        },
      ],
      ctx,
    );
    expect(commands).toHaveLength(0);
  });

  it('Delete 删除选中集', () => {
    const rect = makeShape({ type: 'rect' });
    const ctx = context({ shapes: shapeMap(rect), selection: [rect.id] });
    const { commands } = run(
      [{ type: 'key-down', key: 'Delete', shift: false, ctrl: false, meta: false }],
      ctx,
    );
    expect(first(commands, 'delete-shapes')!.ids).toEqual([rect.id]);
    expect(first(commands, 'select')!.ids).toEqual([]);
  });

  it('工具快捷键与撤销重做快捷键', () => {
    const ctx = context();
    expect(
      first(
        run([{ type: 'key-down', key: 'r', shift: false, ctrl: false, meta: false }], ctx).commands,
        'set-tool',
      )!.tool,
    ).toBe('rect');
    expect(
      first(
        run([{ type: 'key-down', key: 'v', shift: false, ctrl: false, meta: false }], ctx).commands,
        'set-tool',
      )!.tool,
    ).toBe('select');
    expect(
      kinds(
        run([{ type: 'key-down', key: 'z', shift: false, ctrl: true, meta: false }], ctx).commands,
      ),
    ).toEqual(['undo']);
    expect(
      kinds(
        run([{ type: 'key-down', key: 'z', shift: true, ctrl: true, meta: false }], ctx).commands,
      ),
    ).toEqual(['redo']);
    expect(
      kinds(
        run([{ type: 'key-down', key: 'y', shift: false, ctrl: true, meta: false }], ctx).commands,
      ),
    ).toEqual(['redo']);
  });

  it('空选中时 Delete 不产生命令；文本输入目标由组件过滤', () => {
    const ctx = context();
    expect(
      run([{ type: 'key-down', key: 'Delete', shift: false, ctrl: false, meta: false }], ctx)
        .commands,
    ).toHaveLength(0);
  });

  it('未知事件不改变状态', () => {
    const ctx = context();
    const { state, commands } = run(
      [{ type: 'blur' }, { type: 'pointer-cancel' }],
      ctx,
      initialInteractionState(),
    );
    expect(state.kind).toBe('idle');
    expect(commands).toHaveLength(0);
  });

  it('选中单个图形但命中控制点为空时按图形处理', () => {
    const rect = makeShape({ type: 'rect', id: testId(), x: 0, y: 0, w: 10, h: 10 });
    const ctx = context({ shapes: shapeMap(rect), selection: [] });
    const { state } = run(
      [
        {
          type: 'pointer-down',
          pointer: pointer({ point: { x: 5, y: 5 } }),
          target: { kind: 'shape', shapeId: rect.id },
        },
      ],
      ctx,
    );
    expect(state.kind).toBe('dragging');
  });
});
