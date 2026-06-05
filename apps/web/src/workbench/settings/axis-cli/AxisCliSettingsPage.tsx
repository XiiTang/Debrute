import React, { useEffect, useState } from 'react';
import { Download, RefreshCw, RotateCcw, Terminal, Wrench } from 'lucide-react';
import type { AxisCliSkillsStatus, AxisCliStatus } from '@axis/app-protocol';
import type { AxisShellApi } from '../../../api/shellApi';

type OperationState =
  | { status: 'idle' }
  | { status: 'loading'; label: string }
  | { status: 'error'; message: string };

export function AxisCliSettingsPage({
  shell,
  initialStatus
}: {
  shell: AxisShellApi | undefined;
  initialStatus?: AxisCliStatus;
}): React.ReactElement {
  const [status, setStatus] = useState<AxisCliStatus | undefined>(initialStatus);
  const [operation, setOperation] = useState<OperationState>({ status: 'idle' });

  useEffect(() => {
    if (!shell?.getAxisCliStatus || initialStatus) return;
    void shell.getAxisCliStatus()
      .then(setStatus)
      .catch((error) => setOperation({ status: 'error', message: errorMessage(error) }));
  }, [shell, initialStatus]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setOperation({ status: 'loading', label });
    try {
      const result = await action();
      const actionStatus = axisCliStatusFromActionResult(result);
      if (actionStatus) {
        setStatus(actionStatus);
      } else {
        const skillsStatus = axisCliSkillsStatusFromActionResult(result);
        if (skillsStatus) {
          setStatus((current) => withSkillsStatus(current, skillsStatus));
          setOperation({ status: 'idle' });
          return;
        }
        if (shell?.getAxisCliStatus) {
          const refresh = shell.getAxisCliStatus;
          setStatus(await refresh());
        }
      }
      setOperation({ status: 'idle' });
    } catch (error) {
      setOperation({ status: 'error', message: errorMessage(error) });
    }
  };

  const copyManualCommand = async () => {
    if (!shell?.getAxisCliManualInstallCommand || typeof navigator === 'undefined' || !navigator.clipboard) return;
    setOperation({ status: 'loading', label: 'copy' });
    try {
      const manual = await shell.getAxisCliManualInstallCommand();
      await navigator.clipboard.writeText(manual.command);
      setOperation({ status: 'idle' });
    } catch (error) {
      setOperation({ status: 'error', message: errorMessage(error) });
    }
  };

  if (!shell?.getAxisCliStatus) {
    return (
      <section className="settings-section axis-cli-settings-page">
        <header className="settings-section-header">
          <span>Tooling</span>
          <h2>Axis CLI</h2>
          <p>Manual install</p>
        </header>
        <div className="settings-card axis-cli-status-card">
          <strong>Manual install</strong>
          <p>
            Download the matching Axis CLI archive from{' '}
            <a href="https://github.com/XiiTang/AXIS/releases" target="_blank" rel="noreferrer">GitHub Releases</a>,
            verify it with axis_SHA256SUMS, then use the README manual install command for your platform.
          </p>
          <pre><code>axis --version{'\n'}axis skills sync</code></pre>
        </div>
      </section>
    );
  }

  const desktopShell = shell;
  const busy = operation.status === 'loading';
  return (
    <section className="settings-section axis-cli-settings-page">
      <header className="settings-section-header">
        <span>Tooling</span>
        <h2>Axis CLI</h2>
        <p>Command install and Skills sync</p>
      </header>
      <div className="settings-card axis-cli-status-card">
        <strong>{statusLabel(status)}</strong>
        {status ? <AxisCliStatusDetails status={status} /> : <small>Checking</small>}
        {operation.status === 'error' ? <small className="settings-error">{operation.message}</small> : null}
        <div className="settings-actions">
          {status?.kind === 'not_installed' ? (
            <button type="button" disabled={busy || !desktopShell.installAxisCli} onClick={() => void run('install', () => desktopShell.installAxisCli!())}>
              <Download size={14} />Install Axis CLI
            </button>
          ) : null}
          {status?.kind === 'not_installed' || status?.kind === 'error' || status?.kind === 'update_available' ? (
            <button type="button" disabled={busy || !desktopShell.getAxisCliManualInstallCommand} onClick={() => void copyManualCommand()}>
              <Terminal size={14} />Copy Manual Install Command
            </button>
          ) : null}
          {status?.kind === 'update_available' ? (
            <button type="button" disabled={busy || !desktopShell.updateAxisCli} onClick={() => void run('update', () => desktopShell.updateAxisCli!())}>
              <RefreshCw size={14} />Update Axis CLI
            </button>
          ) : null}
          {status?.kind === 'installed_but_not_on_path' ? (
            <button type="button" disabled={busy || !desktopShell.repairAxisCliPath} onClick={() => void run('path', () => desktopShell.repairAxisCliPath!())}>
              <Wrench size={14} />Repair PATH
            </button>
          ) : null}
          {status && status.kind !== 'not_installed' && status.kind !== 'error' ? (
            <button type="button" disabled={busy || !desktopShell.syncAxisCliSkills} onClick={() => void run('sync', () => desktopShell.syncAxisCliSkills!())}>
              <Terminal size={14} />Sync Skills
            </button>
          ) : null}
          {hasPartiallyRemovedSkills(status) ? (
            <button type="button" disabled={busy || !desktopShell.restoreAxisCliSkills} onClick={() => void run('restore', () => desktopShell.restoreAxisCliSkills!())}>
              <RotateCcw size={14} />Restore All Axis Skills
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function AxisCliStatusDetails({ status }: { status: AxisCliStatus }): React.ReactElement {
  const rows: Array<[string, string]> = [];
  if ('cliVersion' in status) rows.push(['CLI', status.cliVersion]);
  if ('desktopVersion' in status) rows.push(['Desktop', status.desktopVersion]);
  if ('managedPath' in status) rows.push(['Path', status.managedPath]);
  if (status.kind === 'not_installed' || status.kind === 'error') rows.push(['Manual', status.manualCommand]);
  const skills = 'skills' in status ? status.skills : undefined;
  if (skills) rows.push(['Skills', skillsStatusLabel(skills)]);
  return (
    <>
      <div className="axis-cli-status-grid">
        {rows.map(([label, value]) => <small key={label}><span>{label}</span>{value}</small>)}
      </div>
      {skills?.kind === 'error' ? <small className="settings-error">{skills.message}</small> : null}
      {skills?.kind === 'partially_removed' ? (
        <div className="settings-pills">
          {skills.skippedDeletedSkills.map((name) => <span key={name}>{name}</span>)}
        </div>
      ) : null}
    </>
  );
}

function statusLabel(status: AxisCliStatus | undefined): string {
  if (!status) return 'Checking';
  if (status.kind === 'not_installed') return 'Not installed';
  if (status.kind === 'update_available') return 'Update available';
  if (status.kind === 'external_newer') return 'External newer CLI';
  if (status.kind === 'installed_but_not_on_path') return 'Installed but not on PATH';
  if (status.kind === 'error') return 'Error';
  return 'Installed';
}

function skillsStatusLabel(status: AxisCliSkillsStatus): string {
  if (status.kind === 'in_sync') return `In sync ${status.axisVersion}`;
  if (status.kind === 'out_of_sync') {
    return status.stateAxisVersion
      ? `Out of sync ${status.stateAxisVersion} -> ${status.cliVersion}`
      : `Out of sync with ${status.cliVersion}`;
  }
  if (status.kind === 'partially_removed') return 'Some official Skills removed';
  return `Error ${status.code}`;
}

function hasPartiallyRemovedSkills(status: AxisCliStatus | undefined): boolean {
  return Boolean(status && 'skills' in status && status.skills.kind === 'partially_removed');
}

export function axisCliStatusFromActionResult(result: unknown): AxisCliStatus | undefined {
  if (typeof result !== 'object' || result === null || !('status' in result)) {
    return undefined;
  }
  const status = (result as { status: unknown }).status;
  return isAxisCliStatus(status) ? status : undefined;
}

export function axisCliSkillsStatusFromActionResult(result: unknown): AxisCliSkillsStatus | undefined {
  if (typeof result !== 'object' || result === null || !('status' in result)) {
    return undefined;
  }
  const status = (result as { status: unknown }).status;
  return isAxisCliSkillsStatus(status) ? status : undefined;
}

function isAxisCliStatus(status: unknown): status is AxisCliStatus {
  return typeof status === 'object'
    && status !== null
    && 'kind' in status
    && 'desktopVersion' in status
    && typeof status.kind === 'string'
    && typeof status.desktopVersion === 'string';
}

function isAxisCliSkillsStatus(status: unknown): status is AxisCliSkillsStatus {
  if (typeof status !== 'object' || status === null || !('kind' in status)) {
    return false;
  }
  const kind = (status as { kind: unknown }).kind;
  return kind === 'in_sync'
    || kind === 'out_of_sync'
    || kind === 'partially_removed'
    || kind === 'error';
}

function withSkillsStatus(
  status: AxisCliStatus | undefined,
  skills: AxisCliSkillsStatus
): AxisCliStatus | undefined {
  if (!status || !('skills' in status)) {
    return status;
  }
  return { ...status, skills };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
