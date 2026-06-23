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

export function AdobeBridgeSettingsPage({
  state,
  actions
}: {
  state: WorkbenchState;
  actions: WorkbenchActions;
}): React.ReactElement {
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
        <h2>Adobe Bridge</h2>
        <Toolbar ariaLabel="Adobe Bridge actions" className="db-action-row">
          <Switch
            label="Enable Adobe Bridge"
            checked={bridge?.settings.enabled === true}
            disabled={saving}
            onChange={(event) => void setEnabled(event.currentTarget.checked)}
          />
        </Toolbar>
      </header>
      {error ? <small className="db-form-error">{error}</small> : null}
      <div className="db-integration-summary">
        <StatusPill tone={bridge?.settings.discoveryStatus === 'available' ? 'success' : bridge?.settings.discoveryStatus === 'disabled' ? 'neutral' : 'danger'}>
          {discoveryLabel(bridge?.settings.discoveryStatus)}
        </StatusPill>
      </div>
      <div className="db-integration-list">
        {(bridge?.adobeClients ?? []).map((client) => {
          const linked = isPhotoshopLinkedToCurrentProject(bridge, currentProjectId, client.adobeClientId);
          return (
            <div className="db-integration-row" key={client.adobeClientId}>
              <span><Cable size={14} /> {client.displayName}</span>
              <StatusPill tone={client.activeDocumentTitle ? 'success' : 'neutral'}>
                {client.activeDocumentTitle ? 'Document open' : 'No document open'}
              </StatusPill>
              <small>{linked ? 'Linked' : 'Available'}</small>
              <div className="db-integration-row__action">
                {linked ? (
                  <Button type="button" iconStart={<Unlink size={14} />} onClick={() => void actions.unlinkAdobeBridgePhotoshop(client.adobeClientId)}>
                    Disconnect
                  </Button>
                ) : (
                  <Button type="button" disabled={!currentProjectId} iconStart={<Link2 size={14} />} onClick={() => void actions.linkAdobeBridgePhotoshop({ adobeClientId: client.adobeClientId })}>
                    Connect
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {(bridge?.projects ?? []).map((project) => (
          <div className="db-integration-row" key={project.projectId}>
            <span>{project.projectName}</span>
            <StatusPill tone="success">Open</StatusPill>
            <small>{project.directories.length} directories</small>
            <div className="db-integration-row__action" />
          </div>
        ))}
      </div>
      {failedTransfers.length > 0 ? (
        <>
          <h3>Recent transfer failures</h3>
          <div className="db-integration-list">
            {failedTransfers.map((transfer) => (
              <div className="db-integration-row" key={transfer.transferId}>
                <span><AlertTriangle size={14} /> {transfer.projectRelativePath ?? transfer.direction}</span>
                <StatusPill tone="danger">Failed</StatusPill>
                <small>{transferFailureLabel(transfer)}</small>
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

function discoveryLabel(status: AdobeBridgeDiscoveryStatus | undefined): string {
  if (status === 'available') return 'Available';
  if (status === 'disabled') return 'Disabled';
  return 'Unavailable';
}

function recentFailedTransfers(bridge: AdobeBridgeStateView | undefined): AdobeBridgeTransferView[] {
  return [...(bridge?.transfers ?? [])]
    .filter((transfer) => transfer.status === 'failed')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5);
}

function transferFailureLabel(transfer: AdobeBridgeTransferView): string {
  return transfer.errorCode ? adobeBridgeErrorLabel(transfer.errorCode) : 'Transfer failed.';
}
