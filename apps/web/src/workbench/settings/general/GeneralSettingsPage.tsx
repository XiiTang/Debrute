import React, { useEffect, useState } from 'react';
import { Download, ExternalLink, RefreshCw, RotateCw } from 'lucide-react';
import type {
  DesktopAppUpdateDisabledReason,
  DesktopAppUpdateState,
  WorkbenchLocale
} from '@debrute/app-protocol';
import type { DebruteShellApi } from '../../../api/shellApi';
import { useI18n, type WorkbenchI18n } from '../../i18n';
import { Button, Card, Field, Select, StatusPill, Toolbar, type StatusTone } from '../../ui';

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
  initialUpdateState,
  locale = 'en',
  onLocaleChange
}: {
  shell: DebruteShellApi | undefined;
  initialUpdateState?: DesktopAppUpdateState;
  locale?: WorkbenchLocale;
  onLocaleChange?: (locale: WorkbenchLocale) => void;
}): React.ReactElement {
  const i18n = useI18n();
  const [updateState, setUpdateState] = useState<DesktopAppUpdateState>(
    initialUpdateState ?? { type: 'disabled', currentVersion: 'unknown', reason: shell?.getAppUpdateState ? 'development' : 'browser' }
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
    <section className="db-settings-section general-settings-page">
      <header className="db-settings-section__header">
        <h2>{i18n.t('settings.general.title')}</h2>
      </header>
      <Card className="db-model-card">
        <strong>{i18n.t('settings.general.language.label')}</strong>
        <Field label={i18n.t('settings.general.language.label')}>
          <Select
            value={locale}
            onChange={(event) => onLocaleChange?.(event.currentTarget.value as WorkbenchLocale)}
          >
            <option value="en">{i18n.t('settings.general.language.english')}</option>
            <option value="zh-CN">{i18n.t('settings.general.language.simplifiedChinese')}</option>
          </Select>
        </Field>
      </Card>
      <Card className="db-model-card">
        <strong>{i18n.t('settings.general.application')}</strong>
        <div className="db-property-grid">
          <small><span>{i18n.t('settings.general.name')}</span>Debrute</small>
          <small><span>{i18n.t('settings.general.currentVersion')}</span>{updateState.currentVersion}</small>
          <small><span>{i18n.t('settings.general.surface')}</span>{surfaceLabel(updateState, i18n)}</small>
          <small><span>{i18n.t('settings.general.platform')}</span>{platformLabel(updateState)}</small>
        </div>
      </Card>
      <AppUpdateCard
        state={updateState}
        operation={operation}
        shell={shell}
        run={run}
        i18n={i18n}
      />
    </section>
  );
}

function AppUpdateCard({
  state,
  operation,
  shell,
  run,
  i18n
}: {
  state: DesktopAppUpdateState;
  operation: OperationState;
  shell: DebruteShellApi | undefined;
  run: (action: () => Promise<DesktopAppUpdateState | { ok: true } | undefined>) => Promise<void>;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const action = appUpdateActionForState(state);
  const busy = operation.status === 'loading';
  return (
    <Card className="db-model-card">
      <div className="db-model-card__header">
        <strong>{i18n.t('settings.general.updates')}</strong>
        <StatusPill tone={statusTone(state)}>{statusLabel(state, i18n)}</StatusPill>
      </div>
      <div className="db-property-grid">
        <small><span>{i18n.t('settings.general.currentVersion')}</span>{state.currentVersion}</small>
        {'updateVersion' in state && state.updateVersion ? <small><span>{i18n.t('settings.general.latestVersion')}</span>{state.updateVersion}</small> : null}
        {'lastCheckedAt' in state && state.lastCheckedAt ? <small><span>{i18n.t('settings.general.lastChecked')}</span>{state.lastCheckedAt}</small> : null}
        {state.type === 'downloading' ? <small><span>{i18n.t('settings.general.progress')}</span>{state.percent}%</small> : null}
      </div>
      <small className={state.type === 'error' || operation.status === 'error' ? 'db-form-error' : 'db-form-help'}>
        {operation.status === 'error' ? operation.message : stateMessage(state, i18n)}
      </small>
      <Toolbar ariaLabel={i18n.t('settings.general.updateActions')} className="db-action-row">
        {action === 'check' ? (
          <Button type="button" disabled={busy || !canRunAppUpdateAction(action, state, shell)} iconStart={<RefreshCw size={14} />} onClick={() => void run(() => shell!.checkForAppUpdate!())}>
            {i18n.t('settings.general.checkForUpdates')}
          </Button>
        ) : null}
        {action === 'download' ? (
          <Button type="button" disabled={busy || !canRunAppUpdateAction(action, state, shell)} iconStart={<Download size={14} />} onClick={() => void run(() => shell!.downloadAppUpdate!())}>
            {i18n.t('settings.general.downloadUpdate')}
          </Button>
        ) : null}
        {action === 'install' ? (
          <Button type="button" disabled={busy || !canRunAppUpdateAction(action, state, shell)} iconStart={<RotateCw size={14} />} onClick={() => void run(() => shell!.installAppUpdate!())}>
            {i18n.t('settings.general.installAndRestart')}
          </Button>
        ) : null}
        {action === 'open-download-page' ? (
          <Button type="button" disabled={busy || !canRunAppUpdateAction(action, state, shell)} iconStart={<ExternalLink size={14} />} onClick={() => void run(() => shell!.openAppUpdateDownloadPage!())}>
            {i18n.t('settings.general.openGithubReleases')}
          </Button>
        ) : null}
      </Toolbar>
    </Card>
  );
}

function statusLabel(state: DesktopAppUpdateState, i18n: WorkbenchI18n): string {
  if (state.type === 'disabled') {
    return i18n.t('settings.general.updateStatus.unavailable');
  }
  if (state.type === 'idle' && state.notAvailable) {
    return i18n.t('settings.general.updateStatus.upToDate');
  }
  if (state.type === 'idle') {
    return i18n.t('settings.general.updateStatus.ready');
  }
  if (state.type === 'checking') {
    return i18n.t('settings.general.updateStatus.checking');
  }
  if (state.type === 'available') {
    return i18n.t('settings.general.updateStatus.available');
  }
  if (state.type === 'downloading') {
    return i18n.t('settings.general.updateStatus.downloading');
  }
  if (state.type === 'downloaded') {
    return i18n.t('settings.general.updateStatus.downloaded');
  }
  if (state.type === 'installing') {
    return i18n.t('settings.general.updateStatus.installing');
  }
  return i18n.t('settings.general.updateStatus.error');
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

function stateMessage(state: DesktopAppUpdateState, i18n: WorkbenchI18n): string {
  if (state.type === 'disabled') {
    return disabledReasonMessage(state.reason, i18n);
  }
  if (state.type === 'checking') {
    return i18n.t('settings.general.updateMessage.checking');
  }
  if (state.type === 'available' && state.installMode === 'manual-download') {
    return i18n.t('settings.general.updateMessage.manualDownload');
  }
  if (state.type === 'available') {
    return i18n.t('settings.general.updateMessage.available');
  }
  if (state.type === 'downloading') {
    return i18n.t('settings.general.updateMessage.downloading');
  }
  if (state.type === 'downloaded') {
    return i18n.t('settings.general.updateMessage.downloaded');
  }
  if (state.type === 'installing') {
    return i18n.t('settings.general.updateMessage.installing');
  }
  if (state.type === 'error') {
    return state.message;
  }
  if (state.notAvailable) {
    return i18n.t('settings.general.updateMessage.upToDate');
  }
  return i18n.t('settings.general.updateMessage.checkLatest');
}

function appUpdateActionForState(state: DesktopAppUpdateState): AppUpdateAction {
  if (state.type === 'disabled' || state.type === 'idle' || state.type === 'checking') {
    return 'check';
  }
  if (state.type === 'available') {
    return state.installMode === 'manual-download' ? 'open-download-page' : 'download';
  }
  if (state.type === 'downloading') {
    return 'download';
  }
  if (state.type === 'downloaded' || state.type === 'installing') {
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

function canRunAppUpdateAction(
  action: AppUpdateAction,
  state: DesktopAppUpdateState,
  shell: DebruteShellApi | undefined
): boolean {
  if (state.type === 'disabled' || state.type === 'checking' || state.type === 'downloading' || state.type === 'installing') {
    return false;
  }
  if (action === 'check') {
    return Boolean(shell?.checkForAppUpdate);
  }
  if (action === 'download') {
    return Boolean(shell?.downloadAppUpdate);
  }
  if (action === 'install') {
    return Boolean(shell?.installAppUpdate);
  }
  if (action === 'open-download-page') {
    return Boolean(shell?.openAppUpdateDownloadPage);
  }
  return false;
}

function disabledReasonMessage(reason: DesktopAppUpdateDisabledReason, i18n: WorkbenchI18n): string {
  if (reason === 'browser') {
    return i18n.t('settings.general.updateMessage.browser');
  }
  if (reason === 'development') {
    return i18n.t('settings.general.updateMessage.development');
  }
  if (reason === 'unsupported-platform') {
    return i18n.t('settings.general.updateMessage.unsupportedPlatform');
  }
  return i18n.t('settings.general.updateMessage.unavailable');
}

function surfaceLabel(state: DesktopAppUpdateState, i18n: WorkbenchI18n): string {
  if (state.type === 'disabled') {
    if (state.reason === 'browser') {
      return i18n.t('settings.general.surface.browser');
    }
    if (state.reason === 'development') {
      return i18n.t('settings.general.surface.desktopDevelopment');
    }
    return i18n.t('settings.general.surface.desktopUnsupported');
  }
  return i18n.t('settings.general.surface.desktopPackaged');
}

function platformLabel(state: DesktopAppUpdateState): string {
  if ('platform' in state && state.platform) {
    return state.platform;
  }
  return state.type === 'disabled' && state.reason === 'browser' ? 'browser' : 'desktop';
}

function isDesktopAppUpdateState(value: unknown): value is DesktopAppUpdateState {
  return typeof value === 'object' && value !== null && 'type' in value && 'currentVersion' in value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
