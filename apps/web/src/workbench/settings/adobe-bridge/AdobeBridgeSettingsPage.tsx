import React, { useState } from 'react';
import { AlertTriangle, Cable, Link2, Unlink } from 'lucide-react';
import type {
  AdobeBridgeDiscoveryStatus,
  AdobeBridgeStateView,
  AdobeBridgeTransferView,
  DebruteGlobalAdobeBridgeSettings
} from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../../types';
import { adobeBridgeErrorLabel } from '../../adobe-bridge/adobeBridgeLabels';
import { Button, StatusPill, Switch, Toolbar } from '../../ui';
import { useI18n, type WorkbenchI18n } from '../../i18n';

type ClientOperation =
  | { status: 'loading' }
  | { status: 'error'; message: string };

export function AdobeBridgeSettingsPage({
  persistedSettings,
  bridge,
  projectId,
  actions
}: {
  persistedSettings: DebruteGlobalAdobeBridgeSettings;
  bridge: AdobeBridgeStateView;
  projectId: string | undefined;
  actions: WorkbenchActions;
}): React.ReactElement {
  const i18n = useI18n();
  const currentProjectId = projectId;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [clientOperations, setClientOperations] = useState<Record<string, ClientOperation | undefined>>({});
  const failedTransfers = recentFailedTransfers(bridge);

  const setEnabled = async (enabled: boolean) => {
    setSaving(true);
    setError(undefined);
    try {
      await actions.saveGlobalSettings({ adobeBridge: { enabled } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const runClientOperation = async (adobeClientId: string, operation: () => Promise<void>) => {
    setClientOperations((current) => ({
      ...current,
      [adobeClientId]: { status: 'loading' }
    }));
    try {
      await operation();
      setClientOperations((current) => ({ ...current, [adobeClientId]: undefined }));
    } catch (err) {
      setClientOperations((current) => ({
        ...current,
        [adobeClientId]: { status: 'error', message: errorMessage(err) }
      }));
    }
  };

  return (
    <section className="settings-page-body adobe-bridge-settings-page">
      <Toolbar ariaLabel={i18n.t('settings.adobeBridge.actions')} className="db-action-row">
        <Switch
          label={i18n.t('settings.adobeBridge.enable')}
          checked={persistedSettings.enabled}
          disabled={saving}
          onChange={(event) => void setEnabled(event.currentTarget.checked)}
        />
      </Toolbar>
      {error ? <small className="db-form-error">{error}</small> : null}
      <div className="db-record-summary">
        <StatusPill tone={bridge.settings.discoveryStatus === 'available' || bridge.settings.discoveryStatus === 'disabled' ? 'neutral' : 'danger'}>
          {discoveryLabel(bridge.settings.discoveryStatus, i18n)}
        </StatusPill>
      </div>
      <div className="db-record-list">
        {bridge.adobeClients.map((client) => {
          const linked = isPhotoshopLinkedToCurrentProject(bridge, currentProjectId, client.adobeClientId);
          const clientOperation = clientOperations[client.adobeClientId];
          const clientOperationLoading = clientOperation?.status === 'loading';
          return (
            <div className="db-record-row" key={client.adobeClientId}>
              <span><Cable size={14} /> {client.displayName}</span>
              <StatusPill tone="neutral">
                {client.activeDocumentTitle ? i18n.t('settings.adobeBridge.documentOpen') : i18n.t('settings.adobeBridge.noDocumentOpen')}
              </StatusPill>
              <small>{linked ? i18n.t('settings.adobeBridge.linked') : i18n.t('settings.adobeBridge.available')}</small>
              <div className="db-record-row__action">
                {linked ? (
                  <Button
                    type="button"
                    loading={clientOperationLoading}
                    iconStart={<Unlink size={14} />}
                    onClick={() => void runClientOperation(
                      client.adobeClientId,
                      () => actions.unlinkAdobeBridgePhotoshop(client.adobeClientId)
                    )}
                  >
                    {i18n.t('settings.adobeBridge.disconnect')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    disabled={!currentProjectId}
                    loading={clientOperationLoading}
                    iconStart={<Link2 size={14} />}
                    onClick={() => void runClientOperation(
                      client.adobeClientId,
                      () => actions.linkAdobeBridgePhotoshop({ adobeClientId: client.adobeClientId })
                    )}
                  >
                    {i18n.t('settings.adobeBridge.connect')}
                  </Button>
                )}
                {clientOperation?.status === 'error' ? (
                  <small className="db-form-error">{clientOperation.message}</small>
                ) : null}
              </div>
            </div>
          );
        })}
        {bridge.projects.map((project) => (
          <div className="db-record-row" key={project.projectId}>
            <span>{project.projectName}</span>
            <StatusPill tone="neutral">{i18n.t('settings.adobeBridge.openProject')}</StatusPill>
            <small>{i18n.t('settings.adobeBridge.directories', { count: project.directories.length })}</small>
            <div className="db-record-row__action" />
          </div>
        ))}
      </div>
      {failedTransfers.length > 0 ? (
        <>
          <h3>{i18n.t('settings.adobeBridge.recentTransferFailures')}</h3>
          <div className="db-record-list">
            {failedTransfers.map((transfer) => (
              <div className="db-record-row" key={transfer.transferId}>
                <span><AlertTriangle size={14} /> {transfer.projectRelativePath ?? transfer.direction}</span>
                <StatusPill tone="danger">{i18n.t('settings.adobeBridge.failed')}</StatusPill>
                <small>{transferFailureLabel(transfer, i18n)}</small>
                <div className="db-record-row__action" />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function isPhotoshopLinkedToCurrentProject(
  bridge: AdobeBridgeStateView,
  currentProjectId: string | undefined,
  adobeClientId: string
): boolean {
  if (!currentProjectId) {
    return false;
  }
  return bridge.links.some((link) => (
    link.projectId === currentProjectId
    && link.adobeClientId === adobeClientId
    && link.status === 'active'
  ));
}

function discoveryLabel(status: AdobeBridgeDiscoveryStatus, i18n: WorkbenchI18n): string {
  if (status === 'available') return i18n.t('settings.adobeBridge.available');
  if (status === 'disabled') return i18n.t('settings.adobeBridge.disabled');
  return i18n.t('settings.adobeBridge.unavailable');
}

function recentFailedTransfers(bridge: AdobeBridgeStateView): AdobeBridgeTransferView[] {
  return [...bridge.transfers]
    .filter((transfer) => transfer.status === 'failed')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5);
}

function transferFailureLabel(transfer: AdobeBridgeTransferView, i18n: WorkbenchI18n): string {
  return transfer.errorCode ? adobeBridgeErrorLabel(transfer.errorCode, i18n) : i18n.t('settings.adobeBridge.transferFailed');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
