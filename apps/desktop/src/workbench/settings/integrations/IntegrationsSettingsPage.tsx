import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type {
  IntegrationBackendStatus,
  IntegrationOperationDiagnostic,
  IntegrationStatus
} from '@axis/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../../types';

type IntegrationActionKind = 'install' | 'update' | 'uninstall';

export function IntegrationsSettingsPage({
  state,
  actions
}: {
  state: WorkbenchState;
  actions: WorkbenchActions;
}): React.ReactElement {
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string>();
  const integrations = state.integrationsSettings?.integrations ?? [];
  const operationRunning = rescanning;

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
    <section className="settings-section integrations-settings-page">
      <header className="settings-section-header integrations-settings-header">
        <span>Optional</span>
        <h2>Integrations</h2>
        <p>AXIS detects optional local capabilities from PATH and shows backend command previews without executing them.</p>
        <div className="settings-actions">
          <button type="button" disabled={operationRunning} onClick={() => void rescan()}>
            <RefreshCw size={14} />
            {rescanning ? 'Rescanning' : 'Rescan'}
          </button>
        </div>
      </header>

      {error ? <small className="settings-error">{error}</small> : null}
      <BackendSummary
        backends={state.integrationsSettings?.backends}
        checking={rescanning || (!state.integrationsSettings?.backends?.length && operationRunning)}
      />

      <div className="integrations-list">
        {integrations.map((integration) => (
          <IntegrationRow
            key={integration.integrationId}
            integration={integration}
          />
        ))}
      </div>
    </section>
  );
}

function IntegrationRow({
  integration
}: {
  integration: IntegrationStatus;
}): React.ReactElement {
  const version = integration.status === 'ready'
    ? integration.binaries.find((binary) => binary.status === 'ready' && binary.version)?.version
    : undefined;
  return (
    <div className="integration-row">
      <span>{integration.displayName}</span>
      <small>{statusLabel(integration.status)}</small>
      <small>{version ?? ''}</small>
      <div className="integration-row-action">
        <IntegrationRowAction integration={integration} />
      </div>
    </div>
  );
}

function BackendSummary({
  backends,
  checking
}: {
  backends: IntegrationBackendStatus[] | undefined;
  checking: boolean;
}): React.ReactElement {
  if (checking) {
    return <small className="integration-backend-summary">Integration backends: checking</small>;
  }
  if (!backends?.length) {
    return <small className="integration-backend-summary">Integration backends: not checked</small>;
  }
  const labels = backends
    .filter((backend) => backend.available && backend.backend)
    .map((backend) => backendLabel(backend.backend));
  const summary = labels.length > 0
    ? labels.join(', ')
    : backends.map((backend) => backend.unavailableReason ?? 'unavailable').join(', ');
  return <small className="integration-backend-summary">Integration backends: {summary}</small>;
}

function IntegrationRowAction({ integration }: { integration: IntegrationStatus }): React.ReactElement | null {
  const status = integration.operationStatus;
  if (!status) {
    return null;
  }
  const previews = commandPreviews(status);
  const reason = neutralReason(status);
  if (previews.length === 0 && !reason && !status.queryDiagnostic) {
    return null;
  }
  return (
    <>
      {previews.map((preview) => (
        <div className="integration-command-preview" key={`${preview.kind}:${preview.command}`}>
          <small>{operationLabel(preview.kind)}</small>
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

function neutralReason(status: NonNullable<IntegrationStatus['operationStatus']>): string | undefined {
  if (status.queryDiagnostic) {
    return 'Unable to check updates.';
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
  return details.length > 0 ? <small className="settings-error">{details.join(' / ')}</small> : null;
}

function statusLabel(status: string): string {
  if (status === 'ready') return 'Ready';
  if (status === 'not_found') return 'Not found';
  if (status === 'probe_failed') return 'Probe failed';
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

function operationLabel(kind: IntegrationActionKind): string {
  if (kind === 'install') return 'Install command';
  if (kind === 'update') return 'Update command';
  return 'Uninstall command';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
