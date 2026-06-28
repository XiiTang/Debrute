import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { TerminalSessionView, WorkbenchApiClient } from '@debrute/app-protocol';
import { CloseButton, EmptyState, IconButton, Tab, TabList, Toolbar } from '../ui';
import { useI18n, type WorkbenchI18n } from '../i18n';
import { useXtermTerminal } from './useXtermTerminal';
import { createTerminalMetadataEventHandler } from './terminalMetadataEvents';
import {
  beginClosingTerminalSession,
  finishClosingTerminalSession,
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

export interface TerminalPanelToolbarProps {
  sessions: TerminalSessionView[];
  activeSessionId: string | null;
  closingSessionIds: string[];
  onSelectSession(terminalId: string): void;
  onCreateSession(): void;
  onCloseSession(session: TerminalSessionView): void;
}

export function TerminalPanelToolbar({
  sessions,
  activeSessionId,
  closingSessionIds,
  onSelectSession,
  onCreateSession,
  onCloseSession
}: TerminalPanelToolbarProps): React.ReactElement {
  const i18n = useI18n();
  return (
    <Toolbar ariaLabel={i18n.t('terminal.sessions')} className="terminal-panel__toolbar">
      <TabList className="db-terminal-tabs" aria-label={i18n.t('terminal.sessions')}>
        {sessions.map((session) => (
          <div key={session.id} className="db-terminal-tab-shell">
            <Tab
              active={session.id === activeSessionId}
              className="db-terminal-tab"
              onClick={() => onSelectSession(session.id)}
            >
              <span>{session.title}</span>
              {session.status === 'exited' || session.status === 'failed' ? (
                <small>{terminalStatusLabel(session.status, i18n)}</small>
              ) : null}
            </Tab>
            <CloseButton
              className="db-terminal-tab__close"
              label={i18n.t('terminal.closeSession', { title: session.title })}
              disabled={closingSessionIds.includes(session.id)}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onCloseSession(session)}
            />
          </div>
        ))}
      </TabList>
      <div className="db-terminal-tab-end-slot">
        <IconButton
          className="db-terminal-tab-new-button"
          label={i18n.t('terminal.new')}
          icon={<Plus size={14} />}
          size="xs"
          onClick={onCreateSession}
        />
      </div>
    </Toolbar>
  );
}

function terminalStatusLabel(status: TerminalSessionView['status'], i18n: WorkbenchI18n): string {
  if (status === 'exited') {
    return i18n.t('terminal.statusExited');
  }
  if (status === 'failed') {
    return i18n.t('terminal.statusFailed');
  }
  return status;
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

  const showEmptyState = shouldShowTerminalEmptyState(state);
  const i18n = useI18n();

  return (
    <div className="terminal-panel">
      <TerminalPanelToolbar
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        closingSessionIds={state.closingSessionIds}
        onSelectSession={(terminalId) => setState((current) => ({ ...current, activeSessionId: terminalId }))}
        onCreateSession={() => void createSession('').catch(showError)}
        onCloseSession={closeSession}
      />
      {state.error ? <div className="terminal-panel__status">{state.error}</div> : null}
      {state.isLoading && state.sessions.length === 0 ? (
        <EmptyState className="terminal-panel__empty" data-testid="terminal-panel-loading-state" title={i18n.t('terminal.starting')} />
      ) : null}
      {!state.isLoading && showEmptyState ? (
        <EmptyState className="terminal-panel__empty" data-testid="terminal-panel-empty-state" title={i18n.t('terminal.noSessions')} />
      ) : !state.isLoading ? (
        <div ref={containerRef} className="terminal-panel__surface" />
      ) : null}
    </div>
  );
}
