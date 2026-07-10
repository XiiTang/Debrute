import type { TerminalSessionView } from '@debrute/app-protocol';

export interface TerminalPanelState {
  sessions: TerminalSessionView[];
  activeSessionId: string | null;
  isLoading: boolean;
  error: string | null;
  closingSessionIds: string[];
}

export function selectNextTerminalSession(
  sessions: TerminalSessionView[],
  closedSessionId: string
): string | null {
  const index = sessions.findIndex((session) => session.id === closedSessionId);
  if (index < 0) {
    return sessions[0]?.id ?? null;
  }
  return sessions[index + 1]?.id ?? sessions[index - 1]?.id ?? null;
}

export function replaceTerminalSession(
  sessions: TerminalSessionView[],
  session: TerminalSessionView
): TerminalSessionView[] {
  return sessions.some((item) => item.id === session.id)
    ? sessions.map((item) => item.id === session.id ? session : item)
    : [...sessions, session];
}

export function beginClosingTerminalSession(
  state: TerminalPanelState,
  terminalId: string
): TerminalPanelState {
  return isTerminalSessionClosing(state, terminalId)
    ? state
    : { ...state, closingSessionIds: [...state.closingSessionIds, terminalId] };
}

export function finishClosingTerminalSession(
  state: TerminalPanelState,
  terminalId: string
): TerminalPanelState {
  return {
    ...state,
    closingSessionIds: state.closingSessionIds.filter((id) => id !== terminalId)
  };
}

export function isTerminalSessionClosing(state: TerminalPanelState, terminalId: string): boolean {
  return state.closingSessionIds.includes(terminalId)
    || state.sessions.some((session) => session.id === terminalId && session.status === 'terminating');
}

export function shouldShowTerminalEmptyState(state: TerminalPanelState): boolean {
  return state.sessions.length === 0 && !state.isLoading && state.error === null;
}
