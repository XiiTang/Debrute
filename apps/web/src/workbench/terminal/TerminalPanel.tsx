import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RotateCcw, X } from 'lucide-react';
import type { TerminalSessionView, WorkbenchApiClient } from '@debrute/app-protocol';
import { EmptyState, IconButton, Tab, TabList, Toolbar } from '../ui';
import { useXtermTerminal } from './useXtermTerminal';
import { createTerminalMetadataEventHandler } from './terminalMetadataEvents';
import {
  beginClosingTerminalSession,
  finishClosingTerminalSession,
  isTerminalSessionClosing,
  replaceTerminalSession,
  selectNextTerminalSession,
  shouldShowTerminalEmptyState,
  type TerminalPanelState
} from './terminalPanelState';

export interface TerminalPanelProps {
  api: WorkbenchApiClient;
  requestedCwdProjectRelativePath: string | null;
  onRequestedCwdConsumed(): void;
}

export function TerminalPanel({
  api,
  requestedCwdProjectRelativePath,
  onRequestedCwdConsumed
}: TerminalPanelProps): React.ReactElement {
  const [state, setState] = useState<TerminalPanelState>({
    sessions: [],
    activeSessionId: null,
    isLoading: true,
    error: null,
    closingSessionIds: []
  });
  const closingSessionIdsRef = useRef(new Set<string>());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeSession = useMemo(
    () => state.sessions.find((session) => session.id === state.activeSessionId) ?? null,
    [state.activeSessionId, state.sessions]
  );
  const backgroundTerminalSessionIdsKey = useMemo(
    () => state.sessions
      .map((session) => session.id)
      .filter((terminalId) => terminalId !== state.activeSessionId)
      .join('\n'),
    [state.activeSessionId, state.sessions]
  );
  const showError = useCallback((error: Error) => {
    setState((current) => ({ ...current, error: error.message }));
  }, []);
  const updateSession = useCallback((session: TerminalSessionView) => {
    setState((current) => ({
      ...current,
      sessions: replaceTerminalSession(current.sessions, session),
      activeSessionId: current.activeSessionId ?? session.id
    }));
  }, []);
  const removeSession = useCallback((terminalId: string) => {
    closingSessionIdsRef.current.delete(terminalId);
    setState((current) => {
      const sessions = current.sessions.filter((session) => session.id !== terminalId);
      return {
        ...current,
        sessions,
        closingSessionIds: current.closingSessionIds.filter((id) => id !== terminalId),
        activeSessionId: current.activeSessionId === terminalId
          ? selectNextTerminalSession(current.sessions, terminalId)
          : current.activeSessionId
      };
    });
  }, []);

  const createSession = useCallback(async (cwdProjectRelativePath = '') => {
    setState((current) => ({ ...current, error: null }));
    const result = await api.createTerminalSession({
      cwdProjectRelativePath
    });
    setState((current) => ({
      ...current,
      sessions: replaceTerminalSession(current.sessions, result.session),
      activeSessionId: result.session.id,
      isLoading: false
    }));
  }, [api]);

  useEffect(() => {
    let disposed = false;
    void api.listTerminalSessions().then(async (result) => {
      if (disposed) {
        return;
      }
      if (result.sessions.length === 0) {
        if (requestedCwdProjectRelativePath !== null) {
          setState((current) => ({ ...current, isLoading: false }));
          return;
        }
        await createSession('');
        return;
      }
      setState({
        sessions: result.sessions,
        activeSessionId: result.sessions[0]!.id,
        isLoading: false,
        error: null,
        closingSessionIds: []
      });
    }).catch((error: Error) => {
      if (!disposed) {
        setState((current) => ({ ...current, isLoading: false, error: error.message }));
      }
    });
    return () => {
      disposed = true;
    };
  }, [api, createSession]);

  useEffect(() => {
    if (!backgroundTerminalSessionIdsKey) {
      return;
    }
    const handleEvent = createTerminalMetadataEventHandler({
      onSessionUpdate: updateSession,
      onSessionClose: removeSession,
      onError: showError
    });
    const subscriptions = backgroundTerminalSessionIdsKey
      .split('\n')
      .map((terminalId) => api.subscribeTerminalEvents(terminalId, handleEvent, showError));
    return () => {
      for (const subscription of subscriptions) {
        subscription.close();
      }
    };
  }, [api, backgroundTerminalSessionIdsKey, removeSession, showError, updateSession]);

  useEffect(() => {
    if (requestedCwdProjectRelativePath === null) {
      return;
    }
    onRequestedCwdConsumed();
    void createSession(requestedCwdProjectRelativePath).catch(showError);
  }, [createSession, onRequestedCwdConsumed, requestedCwdProjectRelativePath, showError]);

  useXtermTerminal({
    api,
    session: activeSession,
    containerRef,
    onSessionUpdate: updateSession,
    onSessionClose: removeSession,
    onError: showError
  });

  const closeSession = useCallback((session: TerminalSessionView) => {
    if (closingSessionIdsRef.current.has(session.id)) {
      return;
    }
    closingSessionIdsRef.current.add(session.id);
    setState((current) => beginClosingTerminalSession(current, session.id));
    void api.closeTerminalSession({ terminalId: session.id }).then(() => {
      removeSession(session.id);
    }).catch((error: Error) => {
      closingSessionIdsRef.current.delete(session.id);
      setState((current) => finishClosingTerminalSession(current, session.id));
      showError(error);
    });
  }, [api, removeSession, showError]);

  const restartActiveSession = useCallback(() => {
    if (!activeSession) {
      return;
    }
    void api.restartTerminalSession({ terminalId: activeSession.id })
      .then((result) => updateSession(result.session))
      .catch(showError);
  }, [activeSession, api, showError, updateSession]);
  const showEmptyState = shouldShowTerminalEmptyState(state);

  return (
    <div className="terminal-panel">
      <Toolbar ariaLabel="Terminal sessions" className="terminal-panel__toolbar">
        <TabList className="terminal-panel__tabs" aria-label="Terminal sessions">
          {state.sessions.map((session) => (
            <Tab
              key={session.id}
              active={session.id === state.activeSessionId}
              className="terminal-panel__tab"
              onClick={() => setState((current) => ({ ...current, activeSessionId: session.id }))}
            >
              <span>{session.title}</span>
              {session.status === 'exited' || session.status === 'failed' ? (
                <small>{session.status}</small>
              ) : null}
            </Tab>
          ))}
        </TabList>
        <div className="terminal-panel__actions">
          <IconButton label="New Terminal" icon={<Plus size={14} />} onClick={() => void createSession('').catch(showError)} />
          <IconButton label="Restart Terminal" icon={<RotateCcw size={14} />} disabled={!activeSession} onClick={restartActiveSession} />
          <IconButton
            label="Close Terminal"
            icon={<X size={14} />}
            disabled={!activeSession || isTerminalSessionClosing(state, activeSession.id)}
            onClick={() => activeSession && closeSession(activeSession)}
          />
        </div>
      </Toolbar>
      {state.error ? <div className="terminal-panel__status">{state.error}</div> : null}
      {state.isLoading && state.sessions.length === 0 ? (
        <EmptyState className="terminal-panel__empty" data-testid="terminal-panel-loading-state" title="Starting terminal" />
      ) : null}
      {!state.isLoading && showEmptyState ? (
        <EmptyState className="terminal-panel__empty" data-testid="terminal-panel-empty-state" title="No terminal sessions" />
      ) : !state.isLoading ? (
        <div ref={containerRef} className="terminal-panel__surface" />
      ) : null}
    </div>
  );
}
