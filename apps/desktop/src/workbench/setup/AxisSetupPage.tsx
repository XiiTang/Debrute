import React, { useState } from 'react';
import { Check, Download, FolderOpen, RefreshCw, Terminal, Wrench } from 'lucide-react';
import type { AxisCliStatus } from '@axis/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';

export function AxisSetupPage({
  state,
  actions
}: {
  state: WorkbenchState;
  actions: WorkbenchActions;
}): React.ReactElement {
  const [error, setError] = useState<string>();
  const status = state.axisCliStatus;
  const running = Boolean(status?.operation?.running);

  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const openProject = async () => {
    await actions.completeSetup();
    await actions.openProject();
  };

  return (
    <main className="axis-setup-page" data-theme="dark">
      <section className="axis-setup-shell">
        <header className="axis-setup-header">
          <span>AXIS Setup</span>
          <h1>AXIS</h1>
        </header>
        <CliSetupStatus status={status} />
        {error ? <small className="settings-error">{error}</small> : null}
        <div className="axis-setup-actions">
          <button type="button" disabled={running} onClick={() => void run(() => primaryCliAction(status, actions))}>
            {primaryCliIcon(status)}
            {primaryCliLabel(status)}
          </button>
          <button type="button" onClick={() => void openProject()}>
            <FolderOpen size={15} />
            Open Project
          </button>
          <button type="button" onClick={() => void actions.completeSetup()}>
            <Check size={15} />
            Continue
          </button>
        </div>
      </section>
    </main>
  );
}

function CliSetupStatus({ status }: { status: AxisCliStatus | undefined }): React.ReactElement {
  const label = statusLabel(status);
  return (
    <div className="axis-setup-status">
      <div className="axis-setup-status-title">
        <Terminal size={18} />
        <strong>{label}</strong>
      </div>
      <dl>
        <div>
          <dt>Command</dt>
          <dd>{status?.commandPath ?? 'Checking'}</dd>
        </div>
        <div>
          <dt>PATH</dt>
          <dd>{pathLabel(status)}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{versionLabel(status)}</dd>
        </div>
        {status?.resolvedPath ? (
          <div>
            <dt>Resolved</dt>
            <dd>{status.resolvedPath}</dd>
          </div>
        ) : null}
        {status?.diagnostic ? (
          <div>
            <dt>Diagnostic</dt>
            <dd>{status.diagnostic.message}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function primaryCliAction(status: AxisCliStatus | undefined, actions: WorkbenchActions): Promise<AxisCliStatus> {
  if (status?.mode === 'source-linked') {
    return actions.refreshAxisCliDevelopmentLink();
  }
  if (status?.mode === 'release' && status.updateAvailable) {
    return actions.updateAxisCli();
  }
  if (status?.mode === 'release') {
    return actions.repairAxisCli();
  }
  if (status?.mode === 'broken') {
    return actions.repairAxisCli();
  }
  return actions.installAxisCli();
}

function primaryCliLabel(status: AxisCliStatus | undefined): string {
  if (status?.operation?.running) return 'Working';
  if (status?.mode === 'source-linked') return 'Refresh Development Link';
  if (status?.mode === 'release' && status.updateAvailable) return 'Update CLI';
  if (status?.mode === 'release') return 'Repair CLI';
  if (status?.mode === 'broken') return 'Repair CLI';
  return 'Install CLI';
}

function primaryCliIcon(status: AxisCliStatus | undefined): React.ReactElement {
  if (status?.mode === 'release' || status?.mode === 'broken') {
    return <Wrench size={15} />;
  }
  if (status?.mode === 'source-linked') {
    return <RefreshCw size={15} />;
  }
  return <Download size={15} />;
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
