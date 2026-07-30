import type { TerminalSessionView } from '@debrute/app-protocol';

export interface TerminalPanelState {
  sessions: TerminalSessionView[];
  activeSessionId: string | null;
  activationTargetId: string | null;
  isLoading: boolean;
  error: string | null;
  closingSessionIds: string[];
}

export function acceptTerminalSessionSnapshot(
  state: TerminalPanelState,
  sessions: TerminalSessionView[]
): TerminalPanelState {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const activationAccepted = state.activationTargetId !== null
    && sessionIds.has(state.activationTargetId);
  let activeSessionId = activationAccepted ? state.activationTargetId : state.activeSessionId;
  if (activeSessionId === null || !sessionIds.has(activeSessionId)) {
    activeSessionId = selectSurvivingTerminalSession(state.sessions, sessions, state.activeSessionId);
  }
  return {
    ...state,
    sessions,
    activeSessionId,
    activationTargetId: activationAccepted ? null : state.activationTargetId,
    isLoading: false,
    closingSessionIds: state.closingSessionIds.filter((id) => sessionIds.has(id))
  };
}

function selectSurvivingTerminalSession(
  previousSessions: TerminalSessionView[],
  sessions: TerminalSessionView[],
  previousActiveSessionId: string | null
): string | null {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const previousIndex = previousActiveSessionId === null
    ? -1
    : previousSessions.findIndex((session) => session.id === previousActiveSessionId);
  if (previousIndex >= 0) {
    const following = previousSessions.slice(previousIndex + 1)
      .find((session) => sessionIds.has(session.id));
    if (following) {
      return following.id;
    }
    const preceding = previousSessions.slice(0, previousIndex)
      .reverse()
      .find((session) => sessionIds.has(session.id));
    if (preceding) {
      return preceding.id;
    }
  }
  return sessions[0]?.id ?? null;
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
