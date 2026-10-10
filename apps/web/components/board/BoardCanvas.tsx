'use client';

/**
 * 画布组件：两层 canvas（内容 + 覆盖层）+ 指针/键盘输入 → 状态机 → store。
 *
 * 关键点：
 *  - 渲染由 zustand 订阅驱动（不走 React 渲染），指针事件里读 store 的实时状态，
 *    避免高频拖拽触发 React 重渲染；
 *  - 状态机（lib/board/interaction.ts）是纯函数：这里只负责
 *    "屏幕坐标 → 世界坐标"、命中测试、以及把命令翻译成 store 调用；
 *  - 视口平移/缩放（中键、平移工具、空格拖拽、滚轮缩放）都在世界坐标之外处理。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { DEFAULT_STYLE, isTypingTarget } from '../../lib/board/defaults';
import type {
  HitTarget,
  InteractionCommand,
  InteractionContext,
  InteractionEvent,
  InteractionState,
  PointerInfo,
} from '../../lib/board/interaction';
import {
  getMarqueeRect,
  getPreviewShape,
  initialInteractionState,
  reduceInteraction,
} from '../../lib/board/interaction';
import { DEFAULT_HIT_TOLERANCE, HANDLE_HIT_RADIUS } from '../../lib/board/hitTest';
import { nextZIndex, visibleShapes } from '../../lib/board/layers';
import type { RemoteCursor } from '../../lib/board/renderer';
import { BoardRenderer, screenToWorld, worldToScreen, zoomAt } from '../../lib/board/renderer';
import { createText, measureTextSize } from '../../lib/board/shapes';
import { useBoardStore } from '../../stores/board';
import { usePresenceStore } from '../../stores/presence';
import { useSessionStore } from '../../stores/session';

interface TextEditorState {
  shapeId: string | null;
  /** 世界坐标：新建文本的落点 */
  at: { x: number; y: number };
  value: string;
}

export function BoardCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);
  /** 状态机状态放 ref：指针事件里同步读写，React 只用来渲染文本编辑器 */
  const machineRef = useRef<InteractionState>(initialInteractionState());
  const spaceRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  const textEditorRef = useRef<TextEditorState | null>(null);
  const committedRef = useRef(false);

  textEditorRef.current = textEditor;

  const tool = useBoardStore((state) => state.tool);
  const viewport = useBoardStore((state) => state.viewport);
  const editorShapeId = textEditor?.shapeId ?? null;

  /** 状态机上下文：每次事件都从 store 取最新值，避免闭包过期 */
  const buildContext = useCallback((): InteractionContext => {
    const store = useBoardStore.getState();
    const user = useSessionStore.getState().user;
    return {
      tool: store.tool,
      shapes: store.sync.shapes,
      selection: store.selection,
      viewport: store.viewport,
      boardId: store.boardId ?? '',
      createdBy: user?.id ?? null,
      style: store.style,
      nextZIndex: nextZIndex(store.sync.shapes),
    };
  }, []);

  /** 画一帧：把 store + 状态机的即时数据推给渲染器 */
  const drawScene = useCallback(
    (options?: { content?: boolean; overlay?: boolean }) => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const store = useBoardStore.getState();
      const presence = usePresenceStore.getState();
      const remoteCursors: RemoteCursor[] = Object.entries(presence.cursors).map(
        ([userId, cursor]) => ({
          userId,
          x: cursor.x,
          y: cursor.y,
          color: presence.members[userId]?.avatarColor ?? '#4c8dff',
          displayName: presence.members[userId]?.displayName ?? '协作者',
        }),
      );
      renderer.update(
        {
          shapes: visibleShapes(store.sync.shapes),
          preview: store.preview ?? getPreviewShape(machineRef.current, buildContext()),
          selection: store.selection,
          marquee: getMarqueeRect(machineRef.current),
          remoteCursors,
          viewport: store.viewport,
        },
        options,
      );
    },
    [buildContext],
  );

  // ---------------------------------------------------------------------------
  // 渲染循环：订阅 store / presence，脏了才重绘（内容层 / 覆盖层分开标脏）
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const content = contentRef.current;
    const overlay = overlayRef.current;
    const container = containerRef.current;
    if (!content || !overlay || !container) return;

    const renderer = new BoardRenderer(content, overlay);
    rendererRef.current = renderer;

    const syncSize = () => {
      const rect = container.getBoundingClientRect();
      renderer.resize(rect.width, rect.height);
      drawScene();
    };
    syncSize();

    const observer = new ResizeObserver(syncSize);
    observer.observe(container);
    const unsubBoard = useBoardStore.subscribe(() => drawScene());
    const unsubPresence = usePresenceStore.subscribe(() =>
      drawScene({ content: false, overlay: true }),
    );

    return () => {
      observer.disconnect();
      unsubBoard();
      unsubPresence();
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [drawScene]);

  // ---------------------------------------------------------------------------
  // 命令执行
  // ---------------------------------------------------------------------------

  const openTextEditor = useCallback(
    (shapeId: string | null, at: { x: number; y: number }, initial: string) => {
      committedRef.current = false;
      setTextEditor({ shapeId, at, value: initial });
    },
    [],
  );

  const runCommands = useCallback(
    (commands: InteractionCommand[]) => {
      const store = useBoardStore.getState();
      for (const command of commands) {
        switch (command.kind) {
          case 'select':
            store.setSelection(command.ids);
            break;
          case 'create-shape':
            store.createShape(command.shape);
            break;
          case 'update-shapes':
            if (command.mode === 'live') store.applyPreview(command.patches);
            else store.commitPatches(command.patches, command.label);
            break;
          case 'delete-shapes':
            store.deleteShapes(command.ids);
            break;
          case 'set-viewport':
            store.setViewport(command.viewport);
            break;
          case 'set-tool':
            store.setTool(command.tool);
            break;
          case 'open-text-editor':
            openTextEditor(command.shapeId, command.at, command.initial);
            break;
          case 'undo':
            store.undo();
            break;
          case 'redo':
            store.redo();
            break;
          default:
            break;
        }
      }
    },
    [openTextEditor],
  );

  const applyEvent = useCallback(
    (event: InteractionEvent) => {
      const result = reduceInteraction(machineRef.current, event, buildContext());
      machineRef.current = result.state;
      runCommands(result.commands);
      drawScene();
    },
    [buildContext, runCommands, drawScene],
  );

  // ---------------------------------------------------------------------------
  // 指针事件
  // ---------------------------------------------------------------------------

  /** 相对画布容器的本地坐标 */
  const localPoint = (event: { clientX: number; clientY: number }) => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const pointerInfo = (
    event: ReactPointerEvent<HTMLCanvasElement>,
    space: boolean,
  ): PointerInfo => {
    const store = useBoardStore.getState();
    return {
      point: screenToWorld(localPoint(event), store.viewport),
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey || event.metaKey,
      button: event.button,
      space,
    };
  };

  const resolveTarget = (world: { x: number; y: number }): HitTarget => {
    const store = useBoardStore.getState();
    const zoom = store.viewport.zoom;
    const handle = store.handleAt(world, HANDLE_HIT_RADIUS / zoom);
    if (handle) {
      const shapeId = store.selection[0];
      if (shapeId) return { kind: 'handle', shapeId, handle };
    }
    const shapeId = store.shapeAt(world, DEFAULT_HIT_TOLERANCE / zoom);
    if (shapeId) return { kind: 'shape', shapeId };
    return { kind: 'none' };
  };

  // 空格 = 临时平移（与中键、平移工具等价）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return;
      event.preventDefault();
      spaceRef.current = true;
      setSpaceHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      spaceRef.current = false;
      setSpaceHeld(false);
    };
    const onBlur = () => {
      spaceRef.current = false;
      setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (textEditorRef.current) return;
    if (event.button === 2) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const info = pointerInfo(event, spaceRef.current);
    applyEvent({ type: 'pointer-down', pointer: info, target: resolveTarget(info.point) });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const info = pointerInfo(event, spaceRef.current);
    // 广播本地光标给其他人（客户端内部按 40ms 节流）
    useBoardStore.getState().sendCursor(info.point);
    if (textEditorRef.current) return;
    applyEvent({ type: 'pointer-move', pointer: info });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button === 2) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (textEditorRef.current) return;
    applyEvent({ type: 'pointer-up', pointer: pointerInfo(event, spaceRef.current) });
  };

  const onDoubleClick = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (textEditorRef.current) return;
    const info = pointerInfo(event, spaceRef.current);
    applyEvent({ type: 'double-click', pointer: info, target: resolveTarget(info.point) });
  };

  // 滚轮缩放：原生监听（React 的 onWheel 是 passive，拿不到 preventDefault）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const store = useBoardStore.getState();
      const rect = container.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = Math.exp(-event.deltaY * 0.0016);
      store.setViewport(zoomAt(store.viewport, point, store.viewport.zoom * factor));
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  // 键盘：删除 / 撤销重做 / 工具快捷键 / Esc
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (textEditorRef.current) return;
      const key = event.key;
      if (['Delete', 'Backspace', 'Escape'].includes(key)) event.preventDefault();
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(key.toLowerCase())) {
        event.preventDefault();
      }
      applyEvent({
        type: 'key-down',
        key,
        shift: event.shiftKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyEvent]);

  // ---------------------------------------------------------------------------
  // 文本编辑（覆盖在画布上的 textarea）
  // ---------------------------------------------------------------------------

  const closeTextEditor = () => {
    committedRef.current = true;
    setTextEditor(null);
    drawScene();
  };

  const commitTextEditor = (value: string) => {
    if (committedRef.current) return;
    committedRef.current = true;
    const editor = textEditorRef.current;
    setTextEditor(null);
    if (!editor) return;
    const store = useBoardStore.getState();
    const user = useSessionStore.getState().user;
    const text = value.replace(/\s+$/u, '');

    if (editor.shapeId) {
      const shape = store.sync.shapes[editor.shapeId];
      if (!shape) return;
      if (!text.trim()) {
        store.deleteShapes([shape.id]); // 清空内容等价于删除
        return;
      }
      const size = measureTextSize(text, shape.style.fontSize ?? DEFAULT_STYLE.fontSize);
      store.commitPatches(
        [{ shapeId: shape.id, patch: { data: { ...shape.data, text }, w: size.w, h: size.h } }],
        '编辑文本',
      );
      return;
    }

    if (!text.trim()) return;
    const shape = createText({
      boardId: store.boardId ?? '',
      style: store.style,
      zIndex: nextZIndex(store.sync.shapes),
      createdBy: user?.id ?? null,
      at: editor.at,
      text,
    });
    store.createShape(shape);
    store.setSelection([shape.id]);
  };

  // 文本编辑器的屏幕位置与样式（不订阅 shape 变化：编辑器存活期间 shape 不会动）
  const editorShape = editorShapeId
    ? useBoardStore.getState().sync.shapes[editorShapeId]
    : undefined;
  const editorScreen = textEditor
    ? worldToScreen(
        { x: editorShape?.x ?? textEditor.at.x, y: editorShape?.y ?? textEditor.at.y },
        viewport,
      )
    : null;
  const editorFontSize = (editorShape?.style.fontSize ?? DEFAULT_STYLE.fontSize) * viewport.zoom;

  return (
    <div ref={containerRef} className="canvas-surface relative h-full w-full overflow-hidden">
      {/* 内容层：图形 + 网格（e2e 按这个 testid 取画布定位） */}
      <canvas ref={contentRef} data-testid="board-canvas" className="absolute inset-0" />
      {/* 覆盖层：选中框 / 控制点 / 他人光标；指针事件挂这一层（它在上） */}
      <canvas
        ref={overlayRef}
        className="absolute inset-0"
        style={{ cursor: cursorFor(tool, spaceHeld) }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => applyEvent({ type: 'pointer-cancel' })}
        onDoubleClick={onDoubleClick}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault(); // 中键不要触发自动滚动
        }}
        onContextMenu={(event) => event.preventDefault()}
      />
      {textEditor && editorScreen ? (
        <textarea
          autoFocus
          defaultValue={textEditor.value}
          onBlur={(event) => commitTextEditor(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeTextEditor();
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              commitTextEditor(event.currentTarget.value);
            }
          }}
          className="absolute resize-none rounded border border-accent/60 bg-white/95 px-1 py-0.5 leading-tight shadow-sm outline-none"
          style={{
            left: editorScreen.x,
            top: editorScreen.y,
            minWidth: 120,
            minHeight: Math.max(24, editorFontSize * 1.4),
            fontSize: editorFontSize,
            color: editorShape?.style.stroke ?? DEFAULT_STYLE.stroke,
            fontFamily: 'inherit',
          }}
          placeholder="输入文本，Enter 确认"
        />
      ) : null}
    </div>
  );
}

/** 光标样式：跟随工具（画图十字、平移抓手、选择默认） */
function cursorFor(tool: string, space: boolean): string {
  if (space || tool === 'pan') return 'grab';
  if (tool === 'select') return 'default';
  if (tool === 'text') return 'text';
  return 'crosshair';
}
