import React, { useState } from 'react';
import { Download, RefreshCw, RotateCw, Trash2, Wrench } from 'lucide-react';
import type { AxisCliStatus } from '@axis/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../../types';

export function CliSettingsPage({
  state,
  actions
}: {
  state: WorkbenchState;
  actions: WorkbenchActions;
}): React.ReactElement {
  const [error, setError] = useState<string>();
  const status = state.axisCliStatus;
  const running = Boolean(status?.operation?.running);
  const run = async (action: () => Promise<AxisCliStatus>) => {
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <section className="settings-section cli-settings-page">
      <header className="settings-section-header cli-settings-header">
        <span>Local command</span>
        <h2>CLI</h2>
        <p>Install and manage the AXIS-owned command path.</p>
        <div className="settings-actions">
          <button type="button" disabled={running} onClick={() => void run(actions.refreshAxisCliStatus)}>
            <RefreshCw size={14} />
            Refresh Status
          </button>
        </div>
      </header>

      <div className="settings-card cli-status-card">
        <strong>{statusLabel(status)}</strong>
        <dl>
          <div><dt>Command</dt><dd>{status?.commandPath ?? 'Checking'}</dd></div>
          <div><dt>Resolved</dt><dd>{status?.resolvedPath ?? 'Not found on PATH'}</dd></div>
          <div><dt>Install root</dt><dd>{status?.installRoot ?? 'Checking'}</dd></div>
          <div><dt>PATH</dt><dd>{pathLabel(status)}</dd></div>
          <div><dt>Version</dt><dd>{versionLabel(status)}</dd></div>
        </dl>
        {status?.conflict ? <small className="settings-error">{status.conflict.message} {status.conflict.resolvedPath}</small> : null}
        {status?.diagnostic ? <small className="settings-error">{status.diagnostic.message}</small> : null}
        {error ? <small className="settings-error">{error}</small> : null}
        <div className="settings-actions cli-action-grid">
          <button type="button" disabled={running} onClick={() => void run(actions.installAxisCli)}>
            <Download size={14} />
            Install
          </button>
          <button type="button" disabled={running || !status?.updateAvailable} onClick={() => void run(actions.updateAxisCli)}>
            <RotateCw size={14} />
            Update CLI
          </button>
          <button type="button" disabled={running} onClick={() => void run(actions.repairAxisCli)}>
            <Wrench size={14} />
            Repair
          </button>
          <button type="button" disabled={running} onClick={() => void run(actions.uninstallAxisCli)}>
            <Trash2 size={14} />
            Uninstall
          </button>
          <button type="button" disabled={running} onClick={() => void run(actions.refreshAxisCliDevelopmentLink)}>
            <RefreshCw size={14} />
            Refresh Development Link
          </button>
        </div>
      </div>
    </section>
  );
}

function statusLabel(status: AxisCliStatus | undefined): string {
  if (!status) return 'CLI checking';
  if (status.mode === 'missing') return 'CLI missing';
  if (status.mode === 'source-linked') return 'CLI source-linked';
  if (status.mode === 'broken') return 'CLI needs repair';
  return status.updateAvailable ? 'CLI update available' : 'CLI installed';
}

function pathLabel(status: AxisCliStatus | undefined): string {
  if (!status) return 'Checking';
  if (status.pathState === 'configured') return 'Configured';
  if (status.pathState === 'configured-pending-terminal') return 'Configured for new terminals';
  if (status.pathState === 'write-failed') return 'Write failed';
  return 'Not configured';
}

function versionLabel(status: AxisCliStatus | undefined): string {
  if (!status?.installedVersion && !status?.latestVersion) return 'Unknown';
  if (status.installedVersion && status.latestVersion) return `${status.installedVersion} / latest ${status.latestVersion}`;
  return status.installedVersion ?? `latest ${status.latestVersion}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
