/**
 * e2e 抓手的"契约测试"：把 tests/e2e/README.md 里的 data-testid 与文本内容
 * 用真实渲染断言一遍。
 *
 * 注意：zustand v5 的 hook 走 useSyncExternalStore，服务端渲染只会拿到 initial state，
 * 所以这里必须用 testing-library 在 jsdom 里真正挂载（客户端渲染路径）。
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BOARD_ID, makeShape } from '../../lib/board/testFixtures';
import { useBoardStore } from '../../stores/board';
import { usePresenceStore } from '../../stores/presence';
import { useSessionStore } from '../../stores/session';
import { PresenceBar } from './PresenceBar';
import { Toolbar } from './Toolbar';

function member(userId: string, displayName: string) {
  return { userId, displayName, avatarColor: '#4c8dff' };
}

afterEach(() => {
  act(() => {
    usePresenceStore.setState({ members: {}, cursors: {} });
    useBoardStore.setState((state) => ({
      ...state,
      sync: { ...state.sync, boardId: null, shapes: {}, pending: [] },
      selection: [],
      undoStack: [],
      redoStack: [],
    }));
  });
});

describe('e2e 抓手', () => {
  it('presence-count 的文本就是在线人数', () => {
    act(() => {
      usePresenceStore.setState({
        members: {
          '11111111-1111-4111-8111-111111111111': member(
            '11111111-1111-4111-8111-111111111111',
            '用户A',
          ),
          '22222222-2222-4222-8222-222222222222': member(
            '22222222-2222-4222-8222-222222222222',
            '用户B',
          ),
        },
      });
    });
    render(<PresenceBar />);
    expect(screen.getByTestId('presence-count').textContent).toBe('2');
  });

  it('invite-code 的文本能直接解析出邀请码（无其它字母数字噪音）', () => {
    render(<PresenceBar inviteCode="ABCD2345" />);
    const text = screen.getByTestId('invite-code').textContent ?? '';
    expect(text).toBe('ABCD2345');
    expect(text.match(/[A-Z0-9]{6,12}/)?.[0]).toBe('ABCD2345');
  });

  it('shape-count 只计可见图形（软删除的不算），并带 tool-rect 抓手', () => {
    const alive = makeShape({ type: 'rect' });
    const deleted = makeShape({ type: 'rect', deletedAt: '2026-01-02T00:00:00.000Z' });
    act(() => {
      useBoardStore.setState((state) => ({
        ...state,
        sync: {
          ...state.sync,
          boardId: BOARD_ID,
          shapes: { [alive.id]: alive, [deleted.id]: deleted },
        },
      }));
    });
    render(<Toolbar />);
    expect(screen.getByTestId('shape-count').textContent).toBe('1');
    expect(screen.getByTestId('tool-rect')).toBeInTheDocument();
  });

  it('空画布时 shape-count 为 0，撤销/重做按栈状态禁用', () => {
    render(<Toolbar />);
    expect(screen.getByTestId('shape-count').textContent).toBe('0');
    expect(screen.getByLabelText('撤销')).toBeDisabled();
    expect(screen.getByLabelText('重做')).toBeDisabled();
  });

  it('点击 tool-rect 会切换当前工具（e2e 画矩形的前置步骤）', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<Toolbar />);
    await user.click(screen.getByTestId('tool-rect'));
    expect(useBoardStore.getState().tool).toBe('rect');
  });

  it('未连接时 presence-count 为 0（不渲染脏数据）', () => {
    act(() => {
      useSessionStore.setState({ status: 'anon', user: null });
    });
    render(<PresenceBar />);
    expect(screen.getByTestId('presence-count').textContent).toBe('0');
  });
});
