import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../styles/terminal.css';
import { Plus } from '../ui/index.js';
import type { TerminalSessionView, WorkbenchApiClient } from '@debrute/app-protocol';
import { CloseButton, EmptyState, IconButton, Tab, TabList, Toolbar } from '../ui/index.js';
import { useI18n, type WorkbenchI18n } from '../i18n';
import type { WorkbenchResolvedTheme } from '../services/workbenchTheme';
import { useXtermTerminal } from './useXtermTerminal';
import {
  acceptTerminalSessionSnapshot,
  beginClosingTerminalSession,
  finishClosingTerminalSession,
  shouldShowTerminalEmptyState,
  type TerminalPanelState
} from './terminalPanelState';

export interface TerminalPanelProps {
  api: WorkbenchApiClient;
  resolvedTheme: WorkbenchResolvedTheme;
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
              appearance="strip"
              className="db-terminal-tab"
              onClick={() => onSelectSession(session.id)}
            >
              <span>{session.title}</span>
              {session.status === 'terminating' || session.status === 'exited' || session.status === 'failed' ? (
                <small>{terminalStatusLabel(session.status, i18n)}</small>
              ) : null}
            </Tab>
            <CloseButton
              className="db-terminal-tab__close"
              label={i18n.t('terminal.closeSession', { title: session.title })}
              disabled={closingSessionIds.includes(session.id) || session.status === 'terminating'}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onCloseSession(session)}
            />
          </div>
        ))}
      </TabList>
      <div className="db-terminal-tab-end-slot">
        <IconButton
          label={i18n.t('terminal.new')}
          icon={<Plus size={14} />}
          size="sm"
          variant="chrome"
          onClick={onCreateSession}
        />
      </div>
    </Toolbar>
  );
}

function terminalStatusLabel(status: TerminalSessionView['status'], i18n: WorkbenchI18n): string {
  if (status === 'terminating') {
    return i18n.t('terminal.statusTerminating');
  }
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
  resolvedTheme,
  requestedCwdProjectRelativePath,
  onRequestedCwdConsumed
}: TerminalPanelProps): React.ReactElement {
  const [state, setState] = useState<TerminalPanelState>({
    sessions: [],
    activeSessionId: null,
    activationTargetId: null,
    isLoading: true,
    error: null,
    closingSessionIds: []
  });
  const closingSessionIdsRef = useRef(new Set<string>());
  const initialTopologyApiRef = useRef<WorkbenchApiClient | null>(null);
  const initialTopologyAcceptedRef = useRef(false);
  const skipAutomaticRootSessionRef = useRef(requestedCwdProjectRelativePath !== null);
  if (initialTopologyApiRef.current !== api) {
    initialTopologyApiRef.current = api;
    initialTopologyAcceptedRef.current = false;
  }
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
    setState((current) => ({ ...current, isLoading: false, error: error.message }));
  }, []);
  const createSession = useCallback(async (cwdProjectRelativePath = '') => {
    setState((current) => ({ ...current, error: null }));
    const result = await api.createTerminalSession({
      cwdProjectRelativePath
    });
    setState((current) => current.sessions.some((session) => session.id === result.session.id)
      ? {
          ...current,
          activeSessionId: result.session.id,
          activationTargetId: null
        }
      : {
          ...current,
          activationTargetId: result.session.id
        });
  }, [api]);

  useEffect(() => {
    const subscription = api.subscribeTerminalSessions((sessions) => {
      const sessionIds = new Set(sessions.map((session) => session.id));
      for (const terminalId of closingSessionIdsRef.current) {
        if (!sessionIds.has(terminalId)) {
          closingSessionIdsRef.current.delete(terminalId);
        }
      }
      const isInitialSnapshot = !initialTopologyAcceptedRef.current;
      initialTopologyAcceptedRef.current = true;
      setState((current) => {
        const accepted = acceptTerminalSessionSnapshot(current, sessions);
        return isInitialSnapshot && sessions.length === 0 && current.error === null
          ? { ...accepted, isLoading: true }
          : accepted;
      });
      if (
        isInitialSnapshot
        && sessions.length === 0
        && !skipAutomaticRootSessionRef.current
      ) {
        void createSession('').catch(showError);
      }
    }, (error) => {
      setState((current) => ({ ...current, isLoading: false, error: error.message }));
    });
    return () => subscription.close();
  }, [api, createSession, showError]);

  useEffect(() => {
    if (!backgroundTerminalSessionIdsKey) {
      return;
    }
    const subscriptions = backgroundTerminalSessionIdsKey
      .split('\n')
      .map((terminalId) => api.subscribeTerminalEvents(terminalId, () => undefined, showError));
    return () => {
      for (const subscription of subscriptions) {
        subscription.close();
      }
    };
  }, [api, backgroundTerminalSessionIdsKey, showError]);

  useEffect(() => {
    if (requestedCwdProjectRelativePath === null) {
      return;
    }
    onRequestedCwdConsumed();
    void createSession(requestedCwdProjectRelativePath).catch(showError);
  }, [createSession, onRequestedCwdConsumed, requestedCwdProjectRelativePath, showError]);

  useXtermTerminal({
    api,
    resolvedTheme,
    session: activeSession,
    containerRef,
    onError: showError
  });

  const closeSession = useCallback((session: TerminalSessionView) => {
    if (closingSessionIdsRef.current.has(session.id)) {
      return;
    }
    closingSessionIdsRef.current.add(session.id);
    setState((current) => beginClosingTerminalSession(current, session.id));
    void (async () => {
      try {
        await api.closeTerminalSession({ terminalId: session.id });
      } catch (error) {
        closingSessionIdsRef.current.delete(session.id);
        setState((current) => finishClosingTerminalSession(current, session.id));
        showError(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  }, [api, showError]);

  const showEmptyState = shouldShowTerminalEmptyState(state);
  const i18n = useI18n();

  return (
    <div className="terminal-panel">
      <TerminalPanelToolbar
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        closingSessionIds={state.closingSessionIds}
        onSelectSession={(terminalId) => setState((current) => ({
          ...current,
          activeSessionId: terminalId,
          activationTargetId: null
        }))}
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
