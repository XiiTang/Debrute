import React, { useEffect, useState } from 'react';
import { Download, ExternalLink, RefreshCw, RotateCw } from 'lucide-react';
import type {
  DesktopAppUpdateDisabledReason,
  DesktopAppUpdateState
} from '@debrute/app-protocol';
import type { DebruteShellApi } from '../../../api/shellApi';
import { Button, Card, StatusPill, Toolbar, type StatusTone } from '../../ui';

type OperationState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string };

type AppUpdateAction =
  | 'none'
  | 'check'
  | 'download'
  | 'install'
  | 'open-download-page';

export function GeneralSettingsPage({
  shell,
  initialUpdateState
}: {
  shell: DebruteShellApi | undefined;
  initialUpdateState?: DesktopAppUpdateState;
}): React.ReactElement {
  const [updateState, setUpdateState] = useState<DesktopAppUpdateState>(
    initialUpdateState ?? { type: 'disabled', currentVersion: 'unknown', reason: shell ? 'unpackaged' : 'browser' }
  );
  const [operation, setOperation] = useState<OperationState>({ status: 'idle' });

  useEffect(() => {
    if (initialUpdateState || !shell?.getAppUpdateState) {
      return;
    }
    void shell.getAppUpdateState()
      .then(setUpdateState)
      .catch((error) => setOperation({ status: 'error', message: errorMessage(error) }));
  }, [shell, initialUpdateState]);

  useEffect(() => (
    shell?.onAppUpdateStateChanged?.((state) => setUpdateState(state))
  ), [shell]);

  const run = async (action: () => Promise<DesktopAppUpdateState | { ok: true } | undefined>) => {
    setOperation({ status: 'loading' });
    try {
      const result = await action();
      if (isDesktopAppUpdateState(result)) {
        setUpdateState(result);
      }
      setOperation({ status: 'idle' });
    } catch (error) {
      setOperation({ status: 'error', message: errorMessage(error) });
    }
  };

  return (
    <section className="settings-section general-settings-page">
      <header className="settings-section-header">
        <h2>General</h2>
      </header>
      <Card className="general-settings-card">
        <strong>Application</strong>
        <div className="general-settings-grid">
          <small><span>Name</span>Debrute</small>
          <small><span>Current version</span>{updateState.currentVersion}</small>
          <small><span>Surface</span>{surfaceLabel(updateState)}</small>
          <small><span>Platform</span>{platformLabel(updateState)}</small>
        </div>
      </Card>
      <AppUpdateCard
        state={updateState}
        operation={operation}
        shell={shell}
        run={run}
      />
    </section>
  );
}

function AppUpdateCard({
  state,
  operation,
  shell,
  run
}: {
  state: DesktopAppUpdateState;
  operation: OperationState;
  shell: DebruteShellApi | undefined;
  run: (action: () => Promise<DesktopAppUpdateState | { ok: true } | undefined>) => Promise<void>;
}): React.ReactElement {
  const action = appUpdateActionForState(state);
  const busy = operation.status === 'loading';
  return (
    <Card className="app-update-card">
      <div className="app-update-header">
        <strong>Updates</strong>
        <StatusPill tone={statusTone(state)}>{statusLabel(state)}</StatusPill>
      </div>
      <div className="general-settings-grid">
        <small><span>Current version</span>{state.currentVersion}</small>
        {'updateVersion' in state && state.updateVersion ? <small><span>Latest version</span>{state.updateVersion}</small> : null}
        {'lastCheckedAt' in state && state.lastCheckedAt ? <small><span>Last checked</span>{state.lastCheckedAt}</small> : null}
        {state.type === 'downloading' ? <small><span>Progress</span>{state.percent}%</small> : null}
      </div>
      <small className={state.type === 'error' || operation.status === 'error' ? 'settings-error' : 'app-update-message'}>
        {operation.status === 'error' ? operation.message : stateMessage(state)}
      </small>
      <Toolbar ariaLabel="Application update actions" className="settings-actions">
        {action === 'check' ? (
          <Button type="button" disabled={busy || !shell?.checkForAppUpdate} iconStart={<RefreshCw size={14} />} onClick={() => void run(() => shell!.checkForAppUpdate!())}>
            Check for Updates
          </Button>
        ) : null}
        {action === 'download' ? (
          <Button type="button" disabled={busy || !shell?.downloadAppUpdate} iconStart={<Download size={14} />} onClick={() => void run(() => shell!.downloadAppUpdate!())}>
            Download Update
          </Button>
        ) : null}
        {action === 'install' ? (
          <Button type="button" disabled={busy || !shell?.installAppUpdate} iconStart={<RotateCw size={14} />} onClick={() => void run(() => shell!.installAppUpdate!())}>
            Install and Restart
          </Button>
        ) : null}
        {action === 'open-download-page' ? (
          <Button type="button" disabled={busy || !shell?.openAppUpdateDownloadPage} iconStart={<ExternalLink size={14} />} onClick={() => void run(() => shell!.openAppUpdateDownloadPage!())}>
            Open GitHub Releases
          </Button>
        ) : null}
      </Toolbar>
    </Card>
  );
}

function statusLabel(state: DesktopAppUpdateState): string {
  if (state.type === 'disabled') {
    return 'Unavailable';
  }
  if (state.type === 'idle' && state.notAvailable) {
    return 'Up to date';
  }
  if (state.type === 'idle') {
    return 'Ready';
  }
  if (state.type === 'checking') {
    return 'Checking';
  }
  if (state.type === 'available') {
    return 'Update available';
  }
  if (state.type === 'downloading') {
    return 'Downloading';
  }
  if (state.type === 'downloaded') {
    return 'Downloaded';
  }
  if (state.type === 'installing') {
    return 'Installing';
  }
  return 'Error';
}

function statusTone(state: DesktopAppUpdateState): StatusTone {
  if (state.type === 'error') {
    return 'danger';
  }
  if (state.type === 'available' || state.type === 'downloaded') {
    return 'warning';
  }
  if (state.type === 'idle' && state.notAvailable) {
    return 'success';
  }
  if (state.type === 'checking' || state.type === 'downloading' || state.type === 'installing') {
    return 'loading';
  }
  return 'neutral';
}

function stateMessage(state: DesktopAppUpdateState): string {
  if (state.type === 'disabled') {
    return disabledReasonMessage(state.reason);
  }
  if (state.type === 'checking') {
    return 'Checking for updates.';
  }
  if (state.type === 'available' && state.installMode === 'manual-download') {
    return 'A new version is available. Download and install it from GitHub Releases.';
  }
  if (state.type === 'available') {
    return 'A new version is available.';
  }
  if (state.type === 'downloading') {
    return 'Downloading update.';
  }
  if (state.type === 'downloaded') {
    return 'Update downloaded and ready to install.';
  }
  if (state.type === 'installing') {
    return 'Installing update and restarting Debrute.';
  }
  if (state.type === 'error') {
    return state.message;
  }
  if (state.notAvailable) {
    return 'Debrute is up to date.';
  }
  return 'Check for the latest Debrute release.';
}

function appUpdateActionForState(state: DesktopAppUpdateState): AppUpdateAction {
  if (state.type === 'idle') {
    return 'check';
  }
  if (state.type === 'available') {
    return state.installMode === 'manual-download' ? 'open-download-page' : 'download';
  }
  if (state.type === 'downloaded') {
    return 'install';
  }
  if (state.type === 'error' && state.retryable) {
    if (state.operation === 'check') {
      return 'check';
    }
    if (state.operation === 'download' && state.updateVersion && state.installMode === 'automatic') {
      return 'download';
    }
    if (state.operation === 'install' && state.updateVersion && state.installMode === 'automatic') {
      return 'install';
    }
  }
  return 'none';
}

function disabledReasonMessage(reason: DesktopAppUpdateDisabledReason): string {
  if (reason === 'browser') {
    return 'Updates are unavailable in browser mode.';
  }
  if (reason === 'development') {
    return 'Updates are unavailable in development builds.';
  }
  if (reason === 'unpackaged') {
    return 'Updates are unavailable in unpackaged builds.';
  }
  if (reason === 'unsupported-platform') {
    return 'Updates are unavailable on this platform.';
  }
  return 'Updates are unavailable because update configuration is missing.';
}

function surfaceLabel(state: DesktopAppUpdateState): string {
  if (state.type === 'disabled') {
    return state.reason === 'browser' ? 'Browser' : 'Desktop unavailable';
  }
  return 'Desktop packaged';
}

function platformLabel(state: DesktopAppUpdateState): string {
  return 'platform' in state ? state.platform : 'unknown';
}

function isDesktopAppUpdateState(value: unknown): value is DesktopAppUpdateState {
  return typeof value === 'object' && value !== null && 'type' in value && 'currentVersion' in value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
