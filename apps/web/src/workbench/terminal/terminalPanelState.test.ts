import { describe, expect, it } from 'vitest';
import type { TerminalSessionView } from '@debrute/app-protocol';
import {
  beginClosingTerminalSession,
  isTerminalSessionClosing,
  replaceTerminalSession,
  selectNextTerminalSession,
  shouldShowTerminalEmptyState,
  type TerminalPanelState
} from './terminalPanelState';

describe('terminalPanelState', () => {
  it('selects the next session after closing the active session', () => {
    const sessions = [
      sessionFixture('one'),
      sessionFixture('two'),
      sessionFixture('three')
    ];

    expect(selectNextTerminalSession(sessions, 'two')).toBe('three');
    expect(selectNextTerminalSession(sessions, 'three')).toBe('two');
    expect(selectNextTerminalSession([sessionFixture('one')], 'one')).toBeNull();
  });

  it('replaces an existing session without reordering tabs', () => {
    const sessions = [sessionFixture('one'), sessionFixture('two')];
    const updated = { ...sessionFixture('one'), status: 'exited' as const };

    expect(replaceTerminalSession(sessions, updated)).toEqual([
      updated,
      sessionFixture('two')
    ]);
  });

  it('tracks session close requests without duplicate pending entries', () => {
    const state = {
      sessions: [sessionFixture('one')],
      activeSessionId: 'one',
      isLoading: false,
      error: null,
      closingSessionIds: []
    };

    const closing = beginClosingTerminalSession(state, 'one');
    const duplicate = beginClosingTerminalSession(closing, 'one');

    expect(isTerminalSessionClosing(duplicate, 'one')).toBe(true);
    expect(duplicate.closingSessionIds).toEqual(['one']);
  });

  it('treats backend terminating status as a closing session', () => {
    const state: TerminalPanelState = {
      sessions: [sessionFixture('one', 'terminating')],
      activeSessionId: 'one',
      isLoading: false,
      error: null,
      closingSessionIds: []
    };

    expect(isTerminalSessionClosing(state, 'one')).toBe(true);
  });

  it('shows the empty state only after loading finishes without sessions or errors', () => {
    const emptyState: TerminalPanelState = {
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      error: null,
      closingSessionIds: []
    };

    expect(shouldShowTerminalEmptyState(emptyState)).toBe(true);
    expect(shouldShowTerminalEmptyState({ ...emptyState, isLoading: true })).toBe(false);
    expect(shouldShowTerminalEmptyState({ ...emptyState, error: 'failed' })).toBe(false);
    expect(shouldShowTerminalEmptyState({ ...emptyState, sessions: [sessionFixture('one')] })).toBe(false);
  });
});

function sessionFixture(id: string, status: TerminalSessionView['status'] = 'running'): TerminalSessionView {
  return {
    id,
    title: id,
    cwdProjectRelativePath: '',
    cols: 80,
    rows: 24,
    status,
    exitCode: status === 'exited' ? 0 : null,
    signal: null,
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z'
  };
}
