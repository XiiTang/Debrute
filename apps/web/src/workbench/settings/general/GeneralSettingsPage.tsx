import React, { useEffect, useState } from 'react';
import { RefreshCw, RotateCw } from '../../ui/index.js';
import type {
  DebruteGlobalSettingsView,
  DebruteProductState,
  ManagedCliDiagnostic,
  ProductUpdateState,
  MutateDebruteGlobalSettingsInput,
  WorkbenchLocale
} from '@debrute/app-protocol';
import type { EventProjection } from '../../../types.js';
import { useI18n, type WorkbenchI18n } from '../../i18n/index.js';
import { Button, Field, Select, StatusPill, Toolbar, type StatusTone } from '../../ui/index.js';
import type { WorkbenchSettingsActions } from '../useWorkbenchSettingsController.js';

type OperationState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string };

type ProductUpdateAction = 'none' | 'check' | 'apply';

type ProductActions = Pick<WorkbenchSettingsActions, 'checkProductUpdate' | 'applyProductUpdate'>;

export function GeneralSettingsPage({
  actions,
  product,
  settings,
  onSettingsChange,
  section = 'general'
}: {
  actions: ProductActions;
  product: EventProjection<DebruteProductState | null>;
  settings: DebruteGlobalSettingsView;
  onSettingsChange: (settings: MutateDebruteGlobalSettingsInput) => Promise<void>;
  section?: 'general' | 'about';
}): React.ReactElement {
  const i18n = useI18n();
  const [operation, setOperation] = useState<OperationState>({ status: 'idle' });
  const [localeDraft, setLocaleDraft] = useState(settings.workbench.locale);
  const [localeOperation, setLocaleOperation] = useState<OperationState>({ status: 'idle' });

  useEffect(() => {
    setLocaleDraft(settings.workbench.locale);
  }, [settings.workbench.locale]);

  const run = async (action: () => Promise<void>) => {
    setOperation({ status: 'loading' });
    try {
      await action();
      setOperation({ status: 'idle' });
    } catch (error) {
      setOperation({ status: 'error', message: errorMessage(error) });
    }
  };

  const saveLocale = async (locale: WorkbenchLocale) => {
    setLocaleOperation({ status: 'loading' });
    try {
      await onSettingsChange({ operation: 'set-locale', locale });
      setLocaleOperation({ status: 'idle' });
    } catch (error) {
      setLocaleOperation({ status: 'error', message: errorMessage(error) });
    }
  };

  return (
    <div className="general-settings-page">
      {section === 'general' ? <section className="settings-group">
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
      </section> : null}
      {section === 'about' ? <section className="settings-group">
        <h3>{i18n.t('settings.general.application')}</h3>
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
      </section> : null}
      {section === 'about' && product.status === 'ready' && product.value ? (
        <ProductUpdateSection
          state={product.value.update}
          operation={operation}
          actions={actions}
          run={run}
          i18n={i18n}
        />
      ) : section === 'about' && product.status === 'loading' ? (
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
      <small className={state.type === 'discovery_failed' || state.type === 'install_failed' || operation.status === 'error' ? 'db-form-error' : 'db-form-help'}>
        {operation.status === 'error' ? operation.message : stateMessage(state, i18n)}
      </small>
      <Toolbar ariaLabel={i18n.t('settings.general.updateActions')} className="db-action-row">
        {action === 'check' ? (
          <Button type="button" disabled={busy || state.type === 'checking'} iconStart={<RefreshCw size={14} />} onClick={() => void run(() => actions.checkProductUpdate())}>
            {i18n.t('settings.general.checkForUpdates')}
          </Button>
        ) : null}
        {action === 'apply' ? (
          <Button type="button" disabled={busy} iconStart={<RotateCw size={14} />} onClick={() => void run(() => actions.applyProductUpdate())}>
            {i18n.t('settings.general.installAndRestart')}
          </Button>
        ) : null}
      </Toolbar>
    </section>
  );
}

function statusLabel(state: ProductUpdateState, i18n: WorkbenchI18n): string {
  if (state.type === 'unknown') {
    return i18n.t('settings.general.updateStatus.unknown');
  }
  if (state.type === 'up_to_date') {
    return i18n.t('settings.general.updateStatus.upToDate');
  }
  if (state.type === 'checking') {
    return i18n.t('settings.general.updateStatus.checking');
  }
  if (state.type === 'available') {
    return i18n.t('settings.general.updateStatus.available');
  }
  if (state.type === 'preparing') {
    return i18n.t('settings.general.updateStatus.preparing');
  }
  if (state.type === 'committing') {
    return i18n.t('settings.general.updateStatus.committing');
  }
  if (state.type === 'install_failed' || state.type === 'discovery_failed') {
    return i18n.t('settings.general.updateStatus.error');
  }
  return i18n.t('settings.general.updateStatus.upToDate');
}

function statusTone(state: ProductUpdateState): StatusTone {
  if (state.type === 'install_failed' || state.type === 'discovery_failed') {
    return 'danger';
  }
  if (state.type === 'available') {
    return 'warning';
  }
  if (state.type === 'checking' || state.type === 'preparing' || state.type === 'committing') {
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
  if (state.type === 'preparing') {
    return i18n.t('settings.general.updateMessage.preparing');
  }
  if (state.type === 'committing') {
    return i18n.t('settings.general.updateMessage.committing');
  }
  if (state.type === 'install_failed' || state.type === 'discovery_failed') {
    return state.message;
  }
  if (state.type === 'unknown') {
    return i18n.t('settings.general.updateMessage.unknown');
  }
  return i18n.t('settings.general.updateMessage.upToDate');
}

function productUpdateActionForState(state: ProductUpdateState): ProductUpdateAction {
  if (state.type === 'unknown' || state.type === 'checking' || state.type === 'up_to_date' || state.type === 'discovery_failed') {
    return 'check';
  }
  if (state.type === 'available' || state.type === 'install_failed') {
    return 'apply';
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
