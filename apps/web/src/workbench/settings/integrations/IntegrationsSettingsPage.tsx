import React, { useEffect, useState } from 'react';
import { Download, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import type {
  IntegrationBackendId,
  IntegrationBackendStatus,
  IntegrationSettingsView,
  IntegrationOperationDiagnostic,
  IntegrationOperationInFlight,
  IntegrationOperationKind,
  IntegrationStatus
} from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../../types';
import { Button, EmptyState, StatusPill, Toolbar } from '../../ui';
import { useI18n, type WorkbenchI18n } from '../../i18n';

export function IntegrationsSettingsPage({
  settings,
  actions
}: {
  settings: IntegrationSettingsView;
  actions: WorkbenchActions;
}): React.ReactElement {
  const i18n = useI18n();
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string>();
  const [localRunningOperation, setLocalRunningOperation] = useState<IntegrationOperationInFlight>();
  const [operationFailure, setOperationFailure] = useState<{
    integrationId: string;
    operation: IntegrationOperationKind;
    stateKey: string;
    diagnostic?: IntegrationOperationDiagnostic;
    message?: string;
  }>();
  const integrations = settings.integrations;
  const runningOperation = settings.runningOperation ?? localRunningOperation;
  const operationRunning = Boolean(runningOperation);

  useEffect(() => {
    if (!operationFailure) {
      return;
    }
    if (integrationFailureStateKey(settings, operationFailure.integrationId) !== operationFailure.stateKey) {
      setOperationFailure(undefined);
    }
  }, [operationFailure, settings]);

  const rescan = async () => {
    setRescanning(true);
    setError(undefined);
    try {
      await actions.rescanIntegrations();
      setOperationFailure(undefined);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRescanning(false);
    }
  };

  return (
    <section className="settings-page-body integrations-settings-page">
      <Toolbar ariaLabel={i18n.t('settings.integrations.actions')} className="db-action-row">
        <Button type="button" disabled={rescanning || operationRunning} iconStart={<RefreshCw size={14} />} onClick={() => void rescan()}>
          {rescanning ? i18n.t('settings.integrations.rescanning') : i18n.t('settings.integrations.rescan')}
        </Button>
      </Toolbar>

      {error ? <small className="db-form-error">{error}</small> : null}
      {integrations.length > 0 ? (
        <BackendSummary
          backends={settings.backends}
          checking={rescanning}
          i18n={i18n}
        />
      ) : null}

      {integrations.length === 0 ? (
        <EmptyState title={i18n.t('settings.integrations.noneAvailable')} />
      ) : (
        <div className="db-record-list">
          {integrations.map((integration) => (
            <IntegrationRow
              key={integration.integrationId}
              integration={integration}
              i18n={i18n}
              operationRunning={operationRunning}
              runningOperation={runningOperation}
              operationFailure={operationFailure?.integrationId === integration.integrationId ? operationFailure : undefined}
              onRunOperation={async (operation) => {
                const localOperation = { integrationId: integration.integrationId, operation };
                setLocalRunningOperation(localOperation);
                setOperationFailure(undefined);
                try {
                  const result = await actions.runIntegrationOperation({ integrationId: integration.integrationId, operation });
                  if (!result.ok) {
                    setOperationFailure({
                      integrationId: result.integrationId,
                      operation: result.operation,
                      stateKey: integrationFailureStateKey(result.settings, result.integrationId),
                      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {})
                    });
                  }
                } catch (err) {
                  setOperationFailure({
                    integrationId: integration.integrationId,
                    operation,
                    stateKey: integrationFailureStateKey(settings, integration.integrationId),
                    message: errorMessage(err)
                  });
                } finally {
                  setLocalRunningOperation((current) => (
                    current?.integrationId === localOperation.integrationId && current.operation === localOperation.operation
                      ? undefined
                      : current
                  ));
                }
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function IntegrationRow({
  integration,
  i18n,
  operationRunning,
  runningOperation,
  operationFailure,
  onRunOperation
}: {
  integration: IntegrationStatus;
  i18n: WorkbenchI18n;
  operationRunning: boolean;
  runningOperation: IntegrationOperationInFlight | undefined;
  operationFailure: { operation: IntegrationOperationKind; diagnostic?: IntegrationOperationDiagnostic; message?: string } | undefined;
  onRunOperation: (operation: IntegrationOperationKind) => Promise<void>;
}): React.ReactElement {
  const version = integration.status === 'ready'
    ? integration.binaries.find((binary) => binary.status === 'ready' && binary.version)?.version
    : undefined;
  return (
    <div className="db-record-row">
      <span>{integration.displayName}</span>
      <StatusPill tone={integration.status === 'probe_failed' ? 'danger' : 'neutral'}>
        {statusLabel(integration.status, i18n)}
      </StatusPill>
      <small>{version ?? ''}</small>
      <div className="db-record-row__action">
        <IntegrationRowAction
          integration={integration}
          i18n={i18n}
          operationRunning={operationRunning}
          runningOperation={runningOperation}
          operationFailure={operationFailure}
          onRunOperation={onRunOperation}
        />
      </div>
    </div>
  );
}

function BackendSummary({
  backends,
  checking,
  i18n
}: {
  backends: IntegrationBackendStatus[];
  checking: boolean;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  if (checking) {
    return <small className="db-record-summary">{i18n.t('settings.integrations.checkingBackends')}</small>;
  }
  if (backends.length === 0) {
    return <small className="db-record-summary">{i18n.t('settings.integrations.noBackends')}</small>;
  }
  const labels = backends
    .flatMap((backend) => backend.available && backend.backend ? [backendLabel(backend.backend)] : []);
  const summary = labels.length > 0
    ? labels.join(', ')
    : backends.map((backend) => backend.unavailableReason ?? i18n.t('settings.integrations.unavailable')).join(', ');
  return <small className="db-record-summary">{summary}</small>;
}

function IntegrationRowAction({
  integration,
  i18n,
  operationRunning,
  runningOperation,
  operationFailure,
  onRunOperation
}: {
  integration: IntegrationStatus;
  i18n: WorkbenchI18n;
  operationRunning: boolean;
  runningOperation: IntegrationOperationInFlight | undefined;
  operationFailure: { operation: IntegrationOperationKind; diagnostic?: IntegrationOperationDiagnostic; message?: string } | undefined;
  onRunOperation: (operation: IntegrationOperationKind) => Promise<void>;
}): React.ReactElement | null {
  const status = integration.operationStatus;
  if (!status) {
    return null;
  }
  const operations = status.availableOperations;
  const reason = neutralReason(status, i18n);
  const activeOperation = runningOperation?.integrationId === integration.integrationId ? runningOperation.operation : undefined;
  if (operations.length === 0 && !reason && !status.queryDiagnostic && !operationFailure) {
    return null;
  }
  return (
    <>
      {operations.length > 0 ? (
        <div className="db-record-row__buttons">
          {operations.map((operation) => (
            <Button
              key={operation}
              type="button"
              disabled={operationRunning}
              iconStart={activeOperation === operation ? <Loader2 size={14} className="db-spin" /> : operationIcon(operation)}
              onClick={() => void onRunOperation(operation)}
            >
              {operationLabel(operation, status, i18n)}
            </Button>
          ))}
        </div>
      ) : null}
      {reason ? <small>{reason}</small> : null}
      {status.queryDiagnostic ? <DiagnosticSummary diagnostic={status.queryDiagnostic} /> : null}
      {operationFailure ? (
        <OperationFailureSummary
          operation={operationFailure.operation}
          diagnostic={operationFailure.diagnostic}
          message={operationFailure.message}
          i18n={i18n}
        />
      ) : null}
    </>
  );
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

function OperationFailureSummary({
  operation,
  diagnostic,
  message,
  i18n
}: {
  operation: IntegrationOperationKind;
  diagnostic: IntegrationOperationDiagnostic | undefined;
  message: string | undefined;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const details = [
    message,
    diagnostic?.errorKind,
    diagnostic?.exitCode !== undefined ? `exit ${diagnostic.exitCode}` : undefined,
    diagnostic?.stderrTail ?? diagnostic?.stdoutTail
  ].filter((item): item is string => Boolean(item));
  return (
    <small className="db-form-error">
      {[operationFailureLabel(operation, i18n), ...details].join(' / ')}
    </small>
  );
}

function statusLabel(status: string, i18n: WorkbenchI18n): string {
  if (status === 'ready') return i18n.t('settings.integrations.ready');
  if (status === 'not_found') return i18n.t('settings.integrations.notFound');
  if (status === 'probe_failed') return i18n.t('settings.integrations.probeFailed');
  return status;
}

function backendLabel(backend: IntegrationBackendId): string {
  if (backend === 'brew') return 'Homebrew';
  if (backend === 'winget') return 'winget';
  if (backend === 'uv') return 'uv';
  return 'pipx';
}

function operationIcon(kind: IntegrationOperationKind): React.ReactElement {
  if (kind === 'install') return <Download size={14} />;
  if (kind === 'update') return <Upload size={14} />;
  return <Trash2 size={14} />;
}

function operationLabel(
  kind: IntegrationOperationKind,
  status: NonNullable<IntegrationStatus['operationStatus']>,
  i18n: WorkbenchI18n
): string {
  if (kind === 'install') return i18n.t('settings.integrations.install');
  if (kind === 'update') return status.latestVersion ?? i18n.t('settings.integrations.update');
  return i18n.t('settings.integrations.uninstall');
}

function operationFailureLabel(kind: IntegrationOperationKind, i18n: WorkbenchI18n): string {
  if (kind === 'install') return i18n.t('settings.integrations.installFailed');
  if (kind === 'update') return i18n.t('settings.integrations.updateFailed');
  return i18n.t('settings.integrations.uninstallFailed');
}

function integrationFailureStateKey(settings: IntegrationSettingsView, integrationId: string): string {
  return JSON.stringify(settings.integrations.find((integration) => integration.integrationId === integrationId) ?? null);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
