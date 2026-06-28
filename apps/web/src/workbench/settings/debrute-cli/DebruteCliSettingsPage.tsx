import React, { useEffect, useState } from 'react';
import { Download, RefreshCw, RotateCcw, Terminal, Wrench } from 'lucide-react';
import type { DebruteCliSkillsStatus, DebruteCliStatus } from '@debrute/app-protocol';
import type { DebruteShellApi } from '../../../api/shellApi';
import { Button, Card, StatusPill, Toolbar } from '../../ui';
import { useI18n, type WorkbenchI18n } from '../../i18n';

type OperationState =
  | { status: 'idle' }
  | { status: 'loading'; label: string }
  | { status: 'error'; message: string };

export function DebruteCliSettingsPage({
  shell,
  initialStatus
}: {
  shell: DebruteShellApi | undefined;
  initialStatus?: DebruteCliStatus;
}): React.ReactElement {
  const i18n = useI18n();
  const [status, setStatus] = useState<DebruteCliStatus | undefined>(initialStatus);
  const [operation, setOperation] = useState<OperationState>({ status: 'idle' });

  useEffect(() => {
    if (!shell?.getDebruteCliStatus || initialStatus) return;
    void shell.getDebruteCliStatus()
      .then(setStatus)
      .catch((error) => setOperation({ status: 'error', message: errorMessage(error) }));
  }, [shell, initialStatus]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setOperation({ status: 'loading', label });
    try {
      const result = await action();
      const actionStatus = debruteCliStatusFromActionResult(result);
      if (actionStatus) {
        setStatus(actionStatus);
      } else {
        const skillsStatus = debruteCliSkillsStatusFromActionResult(result);
        if (skillsStatus) {
          setStatus((current) => withSkillsStatus(current, skillsStatus));
          setOperation({ status: 'idle' });
          return;
        }
        if (shell?.getDebruteCliStatus) {
          const refresh = shell.getDebruteCliStatus;
          setStatus(await refresh());
        }
      }
      setOperation({ status: 'idle' });
    } catch (error) {
      setOperation({ status: 'error', message: errorMessage(error) });
    }
  };

  const copyManualCommand = async () => {
    if (!shell?.getDebruteCliManualInstallCommand || typeof navigator === 'undefined' || !navigator.clipboard) return;
    setOperation({ status: 'loading', label: 'copy' });
    try {
      const manual = await shell.getDebruteCliManualInstallCommand();
      await navigator.clipboard.writeText(manual.command);
      setOperation({ status: 'idle' });
    } catch (error) {
      setOperation({ status: 'error', message: errorMessage(error) });
    }
  };

  if (!shell?.getDebruteCliStatus) {
    return (
      <section className="db-settings-section debrute-cli-settings-page">
        <header className="db-settings-section__header">
          <h2>{i18n.t('settings.debruteCli.title')}</h2>
        </header>
        <Card className="db-model-card">
          <strong>{i18n.t('settings.debruteCli.manualInstall')}</strong>
          <p>
            {i18n.t('settings.debruteCli.manualInstallPrefix')}{' '}
            <a href="https://github.com/XiiTang/Debrute/releases" target="_blank" rel="noreferrer">GitHub Releases</a>
            {i18n.t('settings.debruteCli.manualInstallSuffix')}
          </p>
          <pre><code>debrute --version{'\n'}debrute skills sync</code></pre>
        </Card>
      </section>
    );
  }

  const desktopShell = shell;
  const busy = operation.status === 'loading';
  return (
    <section className="db-settings-section debrute-cli-settings-page">
      <header className="db-settings-section__header">
        <h2>{i18n.t('settings.debruteCli.title')}</h2>
      </header>
      <Card className="db-model-card">
        <strong>{statusLabel(status, i18n)}</strong>
        {status ? <DebruteCliStatusDetails status={status} i18n={i18n} /> : <small>{i18n.t('common.checking')}</small>}
        {operation.status === 'error' ? <small className="db-form-error">{operation.message}</small> : null}
        <Toolbar ariaLabel={i18n.t('settings.debruteCli.actions')} className="db-action-row">
          {status?.kind === 'not_installed' ? (
            <Button type="button" disabled={busy || !desktopShell.installDebruteCli} iconStart={<Download size={14} />} onClick={() => void run('install', () => desktopShell.installDebruteCli!())}>
              {i18n.t('settings.debruteCli.install')}
            </Button>
          ) : null}
          {status?.kind === 'not_installed' || status?.kind === 'error' || status?.kind === 'update_available' ? (
            <Button type="button" disabled={busy || !desktopShell.getDebruteCliManualInstallCommand} iconStart={<Terminal size={14} />} onClick={() => void copyManualCommand()}>
              {i18n.t('settings.debruteCli.copyManualInstallCommand')}
            </Button>
          ) : null}
          {status?.kind === 'update_available' ? (
            <Button type="button" disabled={busy || !desktopShell.updateDebruteCli} iconStart={<RefreshCw size={14} />} onClick={() => void run('update', () => desktopShell.updateDebruteCli!())}>
              {i18n.t('settings.debruteCli.update')}
            </Button>
          ) : null}
          {status?.kind === 'installed_but_not_on_path' ? (
            <Button type="button" disabled={busy || !desktopShell.repairDebruteCliPath} iconStart={<Wrench size={14} />} onClick={() => void run('path', () => desktopShell.repairDebruteCliPath!())}>
              {i18n.t('settings.debruteCli.repairPath')}
            </Button>
          ) : null}
          {status && status.kind !== 'not_installed' && status.kind !== 'error' ? (
            <Button type="button" disabled={busy || !desktopShell.syncDebruteCliSkills} iconStart={<Terminal size={14} />} onClick={() => void run('sync', () => desktopShell.syncDebruteCliSkills!())}>
              {i18n.t('settings.debruteCli.syncSkills')}
            </Button>
          ) : null}
          {hasPartiallyRemovedSkills(status) ? (
            <Button type="button" disabled={busy || !desktopShell.restoreDebruteCliSkills} iconStart={<RotateCcw size={14} />} onClick={() => void run('restore', () => desktopShell.restoreDebruteCliSkills!())}>
              {i18n.t('settings.debruteCli.restoreSkills')}
            </Button>
          ) : null}
        </Toolbar>
      </Card>
    </section>
  );
}

function DebruteCliStatusDetails({ status, i18n }: { status: DebruteCliStatus; i18n: WorkbenchI18n }): React.ReactElement {
  const rows: Array<[string, string]> = [];
  if ('cliVersion' in status) rows.push([i18n.t('settings.debruteCli.cli'), status.cliVersion]);
  if ('desktopVersion' in status) rows.push([i18n.t('settings.debruteCli.desktop'), status.desktopVersion]);
  if ('managedPath' in status) rows.push([i18n.t('settings.debruteCli.path'), status.managedPath]);
  if (status.kind === 'not_installed' || status.kind === 'error') rows.push([i18n.t('settings.debruteCli.manual'), status.manualCommand]);
  const skills = 'skills' in status ? status.skills : undefined;
  if (skills) rows.push([i18n.t('settings.debruteCli.skills'), skillsStatusLabel(skills, i18n)]);
  return (
    <>
      <div className="db-property-grid">
        {rows.map(([label, value]) => <small key={label}><span>{label}</span>{value}</small>)}
      </div>
      {skills?.kind === 'error' ? <small className="db-form-error">{skills.message}</small> : null}
      {skills?.kind === 'partially_removed' ? (
        <div className="db-status-list">
          {skills.skippedDeletedSkills.map((name) => <StatusPill key={name} tone="warning">{name}</StatusPill>)}
        </div>
      ) : null}
    </>
  );
}

function statusLabel(status: DebruteCliStatus | undefined, i18n: WorkbenchI18n): string {
  if (!status) return i18n.t('common.checking');
  if (status.kind === 'not_installed') return i18n.t('settings.debruteCli.notInstalled');
  if (status.kind === 'update_available') return i18n.t('settings.debruteCli.updateAvailable');
  if (status.kind === 'external_newer') return i18n.t('settings.debruteCli.externalNewer');
  if (status.kind === 'installed_but_not_on_path') return i18n.t('settings.debruteCli.installedButNotOnPath');
  if (status.kind === 'error') return i18n.t('common.error');
  return i18n.t('settings.debruteCli.installed');
}

function skillsStatusLabel(status: DebruteCliSkillsStatus, i18n: WorkbenchI18n): string {
  if (status.kind === 'in_sync') return i18n.t('settings.debruteCli.inSync', { version: status.debruteVersion });
  if (status.kind === 'out_of_sync') {
    return status.stateDebruteVersion
      ? i18n.t('settings.debruteCli.outOfSync', { from: status.stateDebruteVersion, to: status.cliVersion })
      : i18n.t('settings.debruteCli.outOfSyncWith', { version: status.cliVersion });
  }
  if (status.kind === 'partially_removed') return i18n.t('settings.debruteCli.someOfficialSkillsRemoved');
  return i18n.t('settings.debruteCli.errorWithCode', { code: status.code });
}

function hasPartiallyRemovedSkills(status: DebruteCliStatus | undefined): boolean {
  return Boolean(status && 'skills' in status && status.skills.kind === 'partially_removed');
}

export function debruteCliStatusFromActionResult(result: unknown): DebruteCliStatus | undefined {
  if (typeof result !== 'object' || result === null || !('status' in result)) {
    return undefined;
  }
  const status = (result as { status: unknown }).status;
  return isDebruteCliStatus(status) ? status : undefined;
}

export function debruteCliSkillsStatusFromActionResult(result: unknown): DebruteCliSkillsStatus | undefined {
  if (typeof result !== 'object' || result === null || !('status' in result)) {
    return undefined;
  }
  const status = (result as { status: unknown }).status;
  return isDebruteCliSkillsStatus(status) ? status : undefined;
}

function isDebruteCliStatus(status: unknown): status is DebruteCliStatus {
  return typeof status === 'object'
    && status !== null
    && 'kind' in status
    && 'desktopVersion' in status
    && typeof status.kind === 'string'
    && typeof status.desktopVersion === 'string';
}

function isDebruteCliSkillsStatus(status: unknown): status is DebruteCliSkillsStatus {
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
  status: DebruteCliStatus | undefined,
  skills: DebruteCliSkillsStatus
): DebruteCliStatus | undefined {
  if (!status || !('skills' in status)) {
    return status;
  }
  return { ...status, skills };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
