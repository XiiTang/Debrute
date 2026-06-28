import React, { useState } from 'react';
import { AlertTriangle, Cable, Link2, Unlink } from 'lucide-react';
import type {
  AdobeBridgeDiscoveryStatus,
  AdobeBridgeStateView,
  AdobeBridgeTransferView
} from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../../types';
import { adobeBridgeErrorLabel } from '../../adobe-bridge/adobeBridgeLabels';
import { Button, StatusPill, Switch, Toolbar } from '../../ui';
import { useI18n, type WorkbenchI18n } from '../../i18n';

export function AdobeBridgeSettingsPage({
  state,
  actions
}: {
  state: WorkbenchState;
  actions: WorkbenchActions;
}): React.ReactElement {
  const i18n = useI18n();
  const bridge = state.adobeBridge;
  const currentProjectId = state.projectId;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const failedTransfers = recentFailedTransfers(bridge);

  const setEnabled = async (enabled: boolean) => {
    setSaving(true);
    setError(undefined);
    try {
      await actions.saveAdobeBridgeSettings({ enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="db-settings-section adobe-bridge-settings-page">
      <header className="db-settings-section__header">
        <h2>{i18n.t('settings.adobeBridge.title')}</h2>
        <Toolbar ariaLabel={i18n.t('settings.adobeBridge.actions')} className="db-action-row">
          <Switch
            label={i18n.t('settings.adobeBridge.enable')}
            checked={bridge?.settings.enabled === true}
            disabled={saving}
            onChange={(event) => void setEnabled(event.currentTarget.checked)}
          />
        </Toolbar>
      </header>
      {error ? <small className="db-form-error">{error}</small> : null}
      <div className="db-integration-summary">
        <StatusPill tone={bridge?.settings.discoveryStatus === 'available' ? 'success' : bridge?.settings.discoveryStatus === 'disabled' ? 'neutral' : 'danger'}>
          {discoveryLabel(bridge?.settings.discoveryStatus, i18n)}
        </StatusPill>
      </div>
      <div className="db-integration-list">
        {(bridge?.adobeClients ?? []).map((client) => {
          const linked = isPhotoshopLinkedToCurrentProject(bridge, currentProjectId, client.adobeClientId);
          return (
            <div className="db-integration-row" key={client.adobeClientId}>
              <span><Cable size={14} /> {client.displayName}</span>
              <StatusPill tone={client.activeDocumentTitle ? 'success' : 'neutral'}>
                {client.activeDocumentTitle ? i18n.t('settings.adobeBridge.documentOpen') : i18n.t('settings.adobeBridge.noDocumentOpen')}
              </StatusPill>
              <small>{linked ? i18n.t('settings.adobeBridge.linked') : i18n.t('settings.adobeBridge.available')}</small>
              <div className="db-integration-row__action">
                {linked ? (
                  <Button type="button" iconStart={<Unlink size={14} />} onClick={() => void actions.unlinkAdobeBridgePhotoshop(client.adobeClientId)}>
                    {i18n.t('settings.adobeBridge.disconnect')}
                  </Button>
                ) : (
                  <Button type="button" disabled={!currentProjectId} iconStart={<Link2 size={14} />} onClick={() => void actions.linkAdobeBridgePhotoshop({ adobeClientId: client.adobeClientId })}>
                    {i18n.t('settings.adobeBridge.connect')}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {(bridge?.projects ?? []).map((project) => (
          <div className="db-integration-row" key={project.projectId}>
            <span>{project.projectName}</span>
            <StatusPill tone="success">{i18n.t('settings.adobeBridge.openProject')}</StatusPill>
            <small>{i18n.t('settings.adobeBridge.directories', { count: project.directories.length })}</small>
            <div className="db-integration-row__action" />
          </div>
        ))}
      </div>
      {failedTransfers.length > 0 ? (
        <>
          <h3>{i18n.t('settings.adobeBridge.recentTransferFailures')}</h3>
          <div className="db-integration-list">
            {failedTransfers.map((transfer) => (
              <div className="db-integration-row" key={transfer.transferId}>
                <span><AlertTriangle size={14} /> {transfer.projectRelativePath ?? transfer.direction}</span>
                <StatusPill tone="danger">{i18n.t('settings.adobeBridge.failed')}</StatusPill>
                <small>{transferFailureLabel(transfer, i18n)}</small>
                <div className="db-integration-row__action" />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function isPhotoshopLinkedToCurrentProject(
  bridge: AdobeBridgeStateView | undefined,
  currentProjectId: string | undefined,
  adobeClientId: string
): boolean {
  if (!bridge || !currentProjectId) {
    return false;
  }
  return bridge.links.some((link) => (
    link.projectId === currentProjectId
    && link.adobeClientId === adobeClientId
    && link.status === 'active'
  ));
}

function discoveryLabel(status: AdobeBridgeDiscoveryStatus | undefined, i18n: WorkbenchI18n): string {
  if (status === 'available') return i18n.t('settings.adobeBridge.available');
  if (status === 'disabled') return i18n.t('settings.adobeBridge.disabled');
  return i18n.t('settings.adobeBridge.unavailable');
}

function recentFailedTransfers(bridge: AdobeBridgeStateView | undefined): AdobeBridgeTransferView[] {
  return [...(bridge?.transfers ?? [])]
    .filter((transfer) => transfer.status === 'failed')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5);
}

function transferFailureLabel(transfer: AdobeBridgeTransferView, i18n: WorkbenchI18n): string {
  return transfer.errorCode ? adobeBridgeErrorLabel(transfer.errorCode, i18n) : i18n.t('settings.adobeBridge.transferFailed');
}
