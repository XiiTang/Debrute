import React, { useEffect, useState } from 'react';
import { RefreshCw, RotateCw } from '../../ui/index.js';
import type {
  DebruteDefaultFrontend,
  DebruteGlobalSettingsView,
  DebruteProductState,
  ManagedCliDiagnostic,
  ProductUpdateState,
  SaveDebruteGlobalSettingsInput,
  WorkbenchLocale,
  WorkbenchThemePreference
} from '@debrute/app-protocol';
import type { EventProjection, WorkbenchActions } from '../../../types';
import { useI18n, type WorkbenchI18n } from '../../i18n';
import type { WorkbenchResolvedTheme } from '../../services/workbenchTheme';
import { Button, Field, Select, StatusPill, Toolbar, type StatusTone } from '../../ui/index.js';

type OperationState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string };

type ProductUpdateAction = 'none' | 'check' | 'apply';

type ProductActions = Pick<WorkbenchActions, 'checkProductUpdate' | 'applyProductUpdate'>;

export function GeneralSettingsPage({
  actions,
  product,
  settings,
  resolvedTheme,
  onSettingsChange
}: {
  actions: ProductActions;
  product: EventProjection<DebruteProductState | null>;
  settings: DebruteGlobalSettingsView;
  resolvedTheme: WorkbenchResolvedTheme;
  onSettingsChange: (settings: SaveDebruteGlobalSettingsInput) => Promise<void>;
}): React.ReactElement {
  const i18n = useI18n();
  const [operation, setOperation] = useState<OperationState>({ status: 'idle' });
  const [themeDraft, setThemeDraft] = useState(settings.workbench.themePreference);
  const [localeDraft, setLocaleDraft] = useState(settings.workbench.locale);
  const [defaultFrontendDraft, setDefaultFrontendDraft] = useState(settings.workbench.defaultFrontend);
  const [themeOperation, setThemeOperation] = useState<OperationState>({ status: 'idle' });
  const [localeOperation, setLocaleOperation] = useState<OperationState>({ status: 'idle' });
  const [defaultFrontendOperation, setDefaultFrontendOperation] = useState<OperationState>({ status: 'idle' });

  useEffect(() => {
    setThemeDraft(settings.workbench.themePreference);
  }, [settings.workbench.themePreference]);

  useEffect(() => {
    setLocaleDraft(settings.workbench.locale);
  }, [settings.workbench.locale]);

  useEffect(() => {
    setDefaultFrontendDraft(settings.workbench.defaultFrontend);
  }, [settings.workbench.defaultFrontend]);

  const run = async (action: () => Promise<void>) => {
    setOperation({ status: 'loading' });
    try {
      await action();
      setOperation({ status: 'idle' });
    } catch (error) {
      setOperation({ status: 'error', message: errorMessage(error) });
    }
  };

  const saveTheme = async (themePreference: WorkbenchThemePreference) => {
    setThemeOperation({ status: 'loading' });
    try {
      await onSettingsChange({ workbench: { themePreference } });
      setThemeOperation({ status: 'idle' });
    } catch (error) {
      setThemeOperation({ status: 'error', message: errorMessage(error) });
    }
  };

  const saveLocale = async (locale: WorkbenchLocale) => {
    setLocaleOperation({ status: 'loading' });
    try {
      await onSettingsChange({ workbench: { locale } });
      setLocaleOperation({ status: 'idle' });
    } catch (error) {
      setLocaleOperation({ status: 'error', message: errorMessage(error) });
    }
  };

  const saveDefaultFrontend = async (defaultFrontend: DebruteDefaultFrontend) => {
    setDefaultFrontendOperation({ status: 'loading' });
    try {
      await onSettingsChange({ workbench: { defaultFrontend } });
      setDefaultFrontendOperation({ status: 'idle' });
    } catch (error) {
      setDefaultFrontendOperation({ status: 'error', message: errorMessage(error) });
    }
  };

  return (
    <div className="general-settings-page">
      <section className="settings-group">
        <h3>{i18n.t('settings.general.appearance')}</h3>
        <Field
          label={i18n.t('settings.general.theme.label')}
          description={themeHelpText(themeDraft, resolvedTheme, i18n)}
        >
          <Select
            value={themeDraft}
            invalid={themeOperation.status === 'error'}
            disabled={themeOperation.status === 'loading'}
            onChange={(event) => {
              const themePreference = event.currentTarget.value as WorkbenchThemePreference;
              setThemeDraft(themePreference);
              void saveTheme(themePreference);
            }}
          >
            <option value="system">{i18n.t('settings.general.theme.system')}</option>
            <option value="dark">{i18n.t('settings.general.theme.dark')}</option>
            <option value="light">{i18n.t('settings.general.theme.light')}</option>
          </Select>
        </Field>
        {themeOperation.status === 'error' ? (
          <small className="db-form-error">
            {i18n.t('settings.general.theme.saveFailed', { message: themeOperation.message })}
          </small>
        ) : null}
      </section>
      <section className="settings-group">
        <h3>{i18n.t('settings.general.language.label')}</h3>
        <Field label={i18n.t('settings.general.language.label')}>
          <Select
            value={localeDraft}
            invalid={localeOperation.status === 'error'}
            disabled={localeOperation.status === 'loading'}
            onChange={(event) => {
              const locale = event.currentTarget.value as WorkbenchLocale;
              setLocaleDraft(locale);
              void saveLocale(locale);
            }}
          >
            <option value="en">{i18n.t('settings.general.language.english')}</option>
            <option value="zh-CN">{i18n.t('settings.general.language.simplifiedChinese')}</option>
          </Select>
        </Field>
        {localeOperation.status === 'error' ? (
          <small className="db-form-error">
            {i18n.t('settings.general.language.saveFailed', { message: localeOperation.message })}
          </small>
        ) : null}
      </section>
      <section className="settings-group">
        <h3>{i18n.t('settings.general.application')}</h3>
        <Field
          label={i18n.t('settings.general.defaultFrontend.label')}
          description={i18n.t('settings.general.defaultFrontend.description')}
        >
          <Select
            value={defaultFrontendDraft}
            invalid={defaultFrontendOperation.status === 'error'}
            disabled={defaultFrontendOperation.status === 'loading'}
            onChange={(event) => {
              const defaultFrontend = event.currentTarget.value as DebruteDefaultFrontend;
              setDefaultFrontendDraft(defaultFrontend);
              void saveDefaultFrontend(defaultFrontend);
            }}
          >
            <option value="desktop">{i18n.t('settings.general.defaultFrontend.desktop')}</option>
            <option value="browser">{i18n.t('settings.general.defaultFrontend.browser')}</option>
            <option value="runtime-only">{i18n.t('settings.general.defaultFrontend.runtimeOnly')}</option>
          </Select>
        </Field>
        {defaultFrontendOperation.status === 'error' ? (
          <small className="db-form-error">
            {i18n.t('settings.general.defaultFrontend.saveFailed', { message: defaultFrontendOperation.message })}
          </small>
        ) : null}
        <div className="settings-property-grid">
          <small><span>{i18n.t('settings.general.name')}</span>Debrute</small>
          <small><span>{i18n.t('settings.general.surface')}</span>{i18n.t('settings.general.surface.desktopPackaged')}</small>
          {product.status === 'ready' && product.value ? (
            <>
              <small><span>{i18n.t('settings.general.currentVersion')}</span>{product.value.productVersion}</small>
              <small><span>{i18n.t('settings.general.platform')}</span>{product.value.platform}</small>
              <small><span>{i18n.t('settings.general.cliDiagnostic')}</span>{cliDiagnosticLabel(product.value.cli, i18n)}</small>
            </>
          ) : null}
        </div>
      </section>
      {product.status === 'ready' && product.value ? (
        <ProductUpdateSection
          state={product.value.update}
          operation={operation}
          actions={actions}
          run={run}
          i18n={i18n}
        />
      ) : product.status === 'loading' ? (
        <section className="settings-group">
          <h3>{i18n.t('settings.general.updates')}</h3>
          <div className="settings-resource-state" aria-busy="true">
            <small>{i18n.t('settings.general.productState.loading')}</small>
          </div>
        </section>
      ) : null}
    </div>
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

function ProductUpdateSection({
  state,
  operation,
  actions,
  run,
  i18n
}: {
  state: ProductUpdateState;
  operation: OperationState;
  actions: ProductActions;
  run: (action: () => Promise<void>) => Promise<void>;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const action = productUpdateActionForState(state);
  const busy = operation.status === 'loading';
  return (
    <section className="settings-group">
      <div className="settings-group__header">
        <h3>{i18n.t('settings.general.updates')}</h3>
        <StatusPill tone={statusTone(state)}>{statusLabel(state, i18n)}</StatusPill>
      </div>
      <div className="settings-property-grid">
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
    </section>
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
