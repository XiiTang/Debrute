import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type {
  IntegrationBackendStatus,
  IntegrationOperationDiagnostic,
  IntegrationStatus
} from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../../types';
import { Button, StatusPill, Toolbar } from '../../ui';
import { useI18n, type WorkbenchI18n } from '../../i18n';

type IntegrationActionKind = 'install' | 'update' | 'uninstall';

export function IntegrationsSettingsPage({
  state,
  actions
}: {
  state: WorkbenchState;
  actions: WorkbenchActions;
}): React.ReactElement {
  const i18n = useI18n();
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string>();
  const integrations = state.integrationsSettings?.integrations ?? [];
  const rescanRunning = rescanning;

  const rescan = async () => {
    setRescanning(true);
    setError(undefined);
    try {
      await actions.rescanIntegrations();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRescanning(false);
    }
  };

  return (
    <section className="db-settings-section integrations-settings-page">
      <header className="db-settings-section__header">
        <h2>{i18n.t('settings.integrations.title')}</h2>
        <Toolbar ariaLabel={i18n.t('settings.integrations.actions')} className="db-action-row">
          <Button type="button" disabled={rescanRunning} iconStart={<RefreshCw size={14} />} onClick={() => void rescan()}>
            {rescanning ? i18n.t('settings.integrations.rescanning') : i18n.t('settings.integrations.rescan')}
          </Button>
        </Toolbar>
      </header>

      {error ? <small className="db-form-error">{error}</small> : null}
      <BackendSummary
        backends={state.integrationsSettings?.backends}
        checking={rescanning || (!state.integrationsSettings?.backends?.length && rescanRunning)}
        i18n={i18n}
      />

      <div className="db-integration-list">
        {integrations.map((integration) => (
          <IntegrationRow
            key={integration.integrationId}
            integration={integration}
            i18n={i18n}
          />
        ))}
      </div>
    </section>
  );
}

function IntegrationRow({
  integration,
  i18n
}: {
  integration: IntegrationStatus;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const version = integration.status === 'ready'
    ? integration.binaries.find((binary) => binary.status === 'ready' && binary.version)?.version
    : undefined;
  return (
    <div className="db-integration-row">
      <span>{integration.displayName}</span>
      <StatusPill tone={integration.status === 'ready' ? 'success' : integration.status === 'probe_failed' ? 'danger' : 'neutral'}>
        {statusLabel(integration.status, i18n)}
      </StatusPill>
      <small>{version ?? ''}</small>
      <div className="db-integration-row__action">
        <IntegrationRowAction integration={integration} i18n={i18n} />
      </div>
    </div>
  );
}

function BackendSummary({
  backends,
  checking,
  i18n
}: {
  backends: IntegrationBackendStatus[] | undefined;
  checking: boolean;
  i18n: WorkbenchI18n;
}): React.ReactElement | null {
  if (checking) {
    return <small className="db-integration-summary">{i18n.t('settings.integrations.checkingBackends')}</small>;
  }
  if (!backends?.length) {
    return null;
  }
  const labels = backends
    .filter((backend) => backend.available && backend.backend)
    .map((backend) => backendLabel(backend.backend));
  const summary = labels.length > 0
    ? labels.join(', ')
    : backends.map((backend) => backend.unavailableReason ?? i18n.t('settings.integrations.unavailable')).join(', ');
  return <small className="db-integration-summary">{summary}</small>;
}

function IntegrationRowAction({ integration, i18n }: { integration: IntegrationStatus; i18n: WorkbenchI18n }): React.ReactElement | null {
  const status = integration.operationStatus;
  if (!status) {
    return null;
  }
  const previews = commandPreviews(status);
  const reason = neutralReason(status, i18n);
  if (previews.length === 0 && !reason && !status.queryDiagnostic) {
    return null;
  }
  return (
    <>
      {previews.map((preview) => (
        <div className="db-integration-command" key={`${preview.kind}:${preview.command}`}>
          <small>{operationLabel(preview.kind, i18n)}</small>
          <code>{preview.command}</code>
        </div>
      ))}
      {reason ? <small>{reason}</small> : null}
      {status.queryDiagnostic ? <DiagnosticSummary diagnostic={status.queryDiagnostic} /> : null}
    </>
  );
}

function commandPreviews(status: NonNullable<IntegrationStatus['operationStatus']>): Array<{ kind: IntegrationActionKind; command: string }> {
  return [
    status.installCommandPreview ? { kind: 'install' as const, command: status.installCommandPreview } : undefined,
    status.updateCommandPreview ? { kind: 'update' as const, command: status.updateCommandPreview } : undefined,
    status.uninstallCommandPreview ? { kind: 'uninstall' as const, command: status.uninstallCommandPreview } : undefined
  ].filter((item): item is { kind: IntegrationActionKind; command: string } => Boolean(item));
}

function neutralReason(status: NonNullable<IntegrationStatus['operationStatus']>, i18n: WorkbenchI18n): string | undefined {
  if (status.queryDiagnostic) {
    return i18n.t('settings.integrations.unableToCheckUpdates');
  }
  return status.unavailableReason;
}

function DiagnosticSummary({ diagnostic }: { diagnostic: IntegrationOperationDiagnostic | undefined }): React.ReactElement | null {
  if (!diagnostic) {
    return null;
  }
  const details = [
    diagnostic.errorKind,
    diagnostic.exitCode !== undefined ? `exit ${diagnostic.exitCode}` : undefined,
    diagnostic.stderrTail ?? diagnostic.stdoutTail
  ].filter((item): item is string => Boolean(item));
  return details.length > 0 ? <small className="db-form-error">{details.join(' / ')}</small> : null;
}

function statusLabel(status: string, i18n: WorkbenchI18n): string {
  if (status === 'ready') return i18n.t('settings.integrations.ready');
  if (status === 'not_found') return i18n.t('settings.integrations.notFound');
  if (status === 'probe_failed') return i18n.t('settings.integrations.probeFailed');
  return status;
}

function backendLabel(backend: string | undefined): string {
  if (backend === 'brew') return 'Homebrew';
  if (backend === 'winget') return 'winget';
  if (backend === 'apt') return 'APT';
  if (backend === 'uv') return 'uv';
  if (backend === 'pipx') return 'pipx';
  return 'unavailable';
}

function operationLabel(kind: IntegrationActionKind, i18n: WorkbenchI18n): string {
  if (kind === 'install') return i18n.t('settings.integrations.installCommand');
  if (kind === 'update') return i18n.t('settings.integrations.updateCommand');
  return i18n.t('settings.integrations.uninstallCommand');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
