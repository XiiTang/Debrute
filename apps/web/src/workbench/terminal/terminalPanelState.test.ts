import { describe, expect, it } from 'vitest';
import type { TerminalSessionView } from '@debrute/app-protocol';
import {
  acceptTerminalSessionSnapshot,
  beginClosingTerminalSession,
  isTerminalSessionClosing,
  shouldShowTerminalEmptyState,
  type TerminalPanelState
} from './terminalPanelState';

describe('terminalPanelState', { tags: ['terminal'] }, () => {
  it('accepts complete topology snapshots and preserves an activation target until it appears', () => {
    const state: TerminalPanelState = {
      sessions: [],
      activeSessionId: null,
      activationTargetId: 'two',
      isLoading: true,
      error: null,
      closingSessionIds: []
    };

    const initial = acceptTerminalSessionSnapshot(state, [sessionFixture('one')]);
    expect(initial.activeSessionId).toBe('one');
    expect(initial.activationTargetId).toBe('two');
    expect(initial.isLoading).toBe(false);

    const created = acceptTerminalSessionSnapshot(initial, [sessionFixture('one'), sessionFixture('two')]);
    expect(created.activeSessionId).toBe('two');
    expect(created.activationTargetId).toBeNull();
  });

  it('selects a surviving neighbor and clears removed closing sessions', () => {
    const state: TerminalPanelState = {
      sessions: [sessionFixture('one'), sessionFixture('two'), sessionFixture('three')],
      activeSessionId: 'two',
      activationTargetId: null,
      isLoading: false,
      error: null,
      closingSessionIds: ['two']
    };

    const accepted = acceptTerminalSessionSnapshot(state, [sessionFixture('one'), sessionFixture('three')]);
    expect(accepted.activeSessionId).toBe('three');
    expect(accepted.closingSessionIds).toEqual([]);
  });

  it('tracks session close requests without duplicate pending entries', () => {
    const state = {
      sessions: [sessionFixture('one')],
      activeSessionId: 'one',
      activationTargetId: null,
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
      activationTargetId: null,
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
      activationTargetId: null,
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
