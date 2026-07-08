import React, { useEffect, useState } from 'react';
import { RefreshCw, RotateCw } from 'lucide-react';
import type {
  DebruteProductState,
  ManagedCliDiagnostic,
  ProductUpdateState,
  SaveWorkbenchPreferencesInput,
  WorkbenchLocale,
  WorkbenchPreferencesView,
  WorkbenchThemePreference
} from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../../types';
import { useI18n, type WorkbenchI18n } from '../../i18n';
import type { WorkbenchResolvedTheme } from '../../services/workbenchTheme';
import { Button, Card, Field, Select, StatusPill, Toolbar, type StatusTone } from '../../ui';

type OperationState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string };

type ProductUpdateAction = 'none' | 'check' | 'apply';

type ProductActions = Pick<WorkbenchActions, 'getProductState' | 'checkProductUpdate' | 'applyProductUpdate'>;

export function GeneralSettingsPage({
  actions,
  initialProductState,
  preferences,
  resolvedTheme,
  onPreferencesChange
}: {
  actions: ProductActions;
  initialProductState?: DebruteProductState;
  preferences: WorkbenchPreferencesView;
  resolvedTheme: WorkbenchResolvedTheme;
  onPreferencesChange: (preferences: SaveWorkbenchPreferencesInput) => Promise<void>;
}): React.ReactElement {
  const i18n = useI18n();
  const [productState, setProductState] = useState<DebruteProductState>(initialProductState ?? defaultProductState());
  const [operation, setOperation] = useState<OperationState>({ status: 'idle' });
  const [preferenceOperation, setPreferenceOperation] = useState<OperationState>({ status: 'idle' });

  useEffect(() => {
    if (initialProductState) {
      return;
    }
    void actions.getProductState()
      .then(setProductState)
      .catch((error) => setOperation({ status: 'error', message: errorMessage(error) }));
  }, [actions, initialProductState]);

  const run = async (action: () => Promise<DebruteProductState | { state: DebruteProductState }>) => {
    setOperation({ status: 'loading' });
    try {
      const result = await action();
      setProductState('state' in result ? result.state : result);
      setOperation({ status: 'idle' });
    } catch (error) {
      setOperation({ status: 'error', message: errorMessage(error) });
    }
  };

  const savePreferences = async (nextPreferences: SaveWorkbenchPreferencesInput) => {
    setPreferenceOperation({ status: 'loading' });
    try {
      await onPreferencesChange(nextPreferences);
      setPreferenceOperation({ status: 'idle' });
    } catch (error) {
      setPreferenceOperation({ status: 'error', message: errorMessage(error) });
    }
  };

  return (
    <section className="db-settings-section general-settings-page">
      <header className="db-settings-section__header">
        <h2>{i18n.t('settings.general.title')}</h2>
      </header>
      <Card className="db-model-card">
        <strong>{i18n.t('settings.general.appearance')}</strong>
        <Field
          label={i18n.t('settings.general.theme.label')}
          description={themeHelpText(preferences.themePreference, resolvedTheme, i18n)}
        >
          <Select
            value={preferences.themePreference}
            disabled={preferenceOperation.status === 'loading'}
            onChange={(event) => void savePreferences({
              ...preferences,
              themePreference: event.currentTarget.value as WorkbenchThemePreference
            })}
          >
            <option value="system">{i18n.t('settings.general.theme.system')}</option>
            <option value="dark">{i18n.t('settings.general.theme.dark')}</option>
            <option value="light">{i18n.t('settings.general.theme.light')}</option>
          </Select>
        </Field>
        {preferenceOperation.status === 'error' ? (
          <small className="db-form-error">
            {i18n.t('settings.general.theme.saveFailed', { message: preferenceOperation.message })}
          </small>
        ) : null}
      </Card>
      <Card className="db-model-card">
        <strong>{i18n.t('settings.general.language.label')}</strong>
        <Field label={i18n.t('settings.general.language.label')}>
          <Select
            value={preferences.locale}
            disabled={preferenceOperation.status === 'loading'}
            onChange={(event) => void savePreferences({
              ...preferences,
              locale: event.currentTarget.value as WorkbenchLocale
            })}
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
          <small><span>{i18n.t('settings.general.currentVersion')}</span>{productState.productVersion}</small>
          <small><span>{i18n.t('settings.general.surface')}</span>{i18n.t('settings.general.surface.desktopPackaged')}</small>
          <small><span>{i18n.t('settings.general.platform')}</span>{productState.platform}</small>
          <small><span>{i18n.t('settings.general.cliDiagnostic')}</span>{cliDiagnosticLabel(productState.cli, i18n)}</small>
        </div>
      </Card>
      <ProductUpdateCard
        state={productState.update}
        operation={operation}
        actions={actions}
        run={run}
        i18n={i18n}
      />
    </section>
  );
}

function themeHelpText(
  preference: WorkbenchThemePreference,
  resolvedTheme: WorkbenchResolvedTheme,
  i18n: WorkbenchI18n
): string {
  if (preference === 'system') {
    return i18n.t('settings.general.theme.usingSystem', {
      theme: resolvedTheme === 'dark'
        ? i18n.t('settings.general.theme.resolvedDark')
        : i18n.t('settings.general.theme.resolvedLight')
    });
  }
  return i18n.t('settings.general.theme.appliedGlobal');
}

function ProductUpdateCard({
  state,
  operation,
  actions,
  run,
  i18n
}: {
  state: ProductUpdateState;
  operation: OperationState;
  actions: ProductActions;
  run: (action: () => Promise<DebruteProductState | { state: DebruteProductState }>) => Promise<void>;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const action = productUpdateActionForState(state);
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
      </div>
      <small className={state.type === 'error' || operation.status === 'error' ? 'db-form-error' : 'db-form-help'}>
        {operation.status === 'error' ? operation.message : stateMessage(state, i18n)}
      </small>
      <Toolbar ariaLabel={i18n.t('settings.general.updateActions')} className="db-action-row">
        {action === 'check' ? (
          <Button type="button" disabled={busy || state.type === 'checking'} iconStart={<RefreshCw size={14} />} onClick={() => void run(() => actions.checkProductUpdate())}>
            {i18n.t('settings.general.checkForUpdates')}
          </Button>
        ) : null}
        {action === 'apply' ? (
          <Button type="button" disabled={busy || state.type === 'installing'} iconStart={<RotateCw size={14} />} onClick={() => void run(() => actions.applyProductUpdate())}>
            {i18n.t('settings.general.installAndRestart')}
          </Button>
        ) : null}
      </Toolbar>
    </Card>
  );
}

function statusLabel(state: ProductUpdateState, i18n: WorkbenchI18n): string {
  if (state.type === 'idle') {
    return i18n.t('settings.general.updateStatus.upToDate');
  }
  if (state.type === 'checking') {
    return i18n.t('settings.general.updateStatus.checking');
  }
  if (state.type === 'available') {
    return i18n.t('settings.general.updateStatus.available');
  }
  if (state.type === 'installing') {
    return i18n.t('settings.general.updateStatus.installing');
  }
  return i18n.t('settings.general.updateStatus.error');
}

function statusTone(state: ProductUpdateState): StatusTone {
  if (state.type === 'error') {
    return 'danger';
  }
  if (state.type === 'available') {
    return 'warning';
  }
  if (state.type === 'idle') {
    return 'success';
  }
  if (state.type === 'checking' || state.type === 'installing') {
    return 'loading';
  }
  return 'neutral';
}

function stateMessage(state: ProductUpdateState, i18n: WorkbenchI18n): string {
  if (state.type === 'checking') {
    return i18n.t('settings.general.updateMessage.checking');
  }
  if (state.type === 'available') {
    return i18n.t('settings.general.updateMessage.available');
  }
  if (state.type === 'installing') {
    return i18n.t('settings.general.updateMessage.installing');
  }
  if (state.type === 'error') {
    return state.message;
  }
  return i18n.t('settings.general.updateMessage.upToDate');
}

function productUpdateActionForState(state: ProductUpdateState): ProductUpdateAction {
  if (state.type === 'idle' || state.type === 'checking') {
    return 'check';
  }
  if (state.type === 'available' || state.type === 'installing') {
    return 'apply';
  }
  if (state.type === 'error') {
    return state.operation === 'check' ? 'check' : 'apply';
  }
  return 'none';
}

export function cliDiagnosticLabel(cli: ManagedCliDiagnostic, i18n: WorkbenchI18n): string {
  if (cli.status === 'ready') {
    return i18n.t('settings.general.cliDiagnosticReady', {
      version: cli.version,
      path: cli.path,
      skillsVersion: cli.skillsVersion
    });
  }
  return i18n.t('settings.general.cliDiagnosticError', {
    version: cli.version,
    message: cli.message,
    path: cli.path ?? i18n.t('common.none')
  });
}

function defaultProductState(): DebruteProductState {
  const platform = (globalThis as { process?: { platform?: NodeJS.Platform } }).process?.platform ?? 'linux';
  return {
    productVersion: 'unknown',
    platform,
    cli: {
      status: 'error',
      version: 'unknown',
      message: 'Debrute runtime product state has not loaded.'
    },
    update: {
      type: 'idle',
      currentVersion: 'unknown',
      updateAvailable: false
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
