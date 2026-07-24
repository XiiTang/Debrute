import React, { useEffect, useState } from 'react';
import { AlertTriangle, Cable, KeyRound, Link2, Trash2, Unlink, X } from 'lucide-react';
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

interface PendingPairing {
  pairingId: string;
  code: string;
  expiresAt: string;
  pairedPluginIdsAtCreation: string[];
}

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
  const [pairing, setPairing] = useState<PendingPairing>();
  const [clientOperations, setClientOperations] = useState<Record<string, ClientOperation | undefined>>({});
  const failedTransfers = recentFailedTransfers(bridge);

  useEffect(() => {
    if (!pairing) return;
    const pairedAtCreation = new Set(pairing.pairedPluginIdsAtCreation);
    if (bridge.pairedPlugins.some((plugin) => !pairedAtCreation.has(plugin.pluginInstanceId))) {
      setPairing(undefined);
      return;
    }
    const remaining = Date.parse(pairing.expiresAt) - Date.now();
    if (remaining <= 0) {
      setPairing(undefined);
      return;
    }
    const timeout = window.setTimeout(() => setPairing(undefined), remaining);
    return () => window.clearTimeout(timeout);
  }, [bridge.pairedPlugins, pairing]);

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

  const runClientOperation = async (pluginInstanceId: string, operation: () => Promise<void>) => {
    setClientOperations((current) => ({
      ...current,
      [pluginInstanceId]: { status: 'loading' }
    }));
    try {
      await operation();
      setClientOperations((current) => ({ ...current, [pluginInstanceId]: undefined }));
    } catch (err) {
      setClientOperations((current) => ({
        ...current,
        [pluginInstanceId]: { status: 'error', message: errorMessage(err) }
      }));
    }
  };

  const createPairing = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const created = await actions.createAdobeBridgePairing();
      setPairing({
        ...created,
        pairedPluginIdsAtCreation: bridge.pairedPlugins.map((plugin) => plugin.pluginInstanceId)
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const cancelPairing = async () => {
    if (!pairing) return;
    setSaving(true);
    setError(undefined);
    try {
      await actions.cancelAdobeBridgePairing(pairing.pairingId);
      setPairing(undefined);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
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
        <Button
          type="button"
          disabled={!persistedSettings.enabled || saving}
          iconStart={<KeyRound size={14} />}
          onClick={() => void createPairing()}
        >
          {i18n.t(pairing ? 'settings.adobeBridge.replacePairing' : 'settings.adobeBridge.pairPlugin')}
        </Button>
        {pairing ? (
          <Button type="button" disabled={saving} iconStart={<X size={14} />} onClick={() => void cancelPairing()}>
            {i18n.t('settings.adobeBridge.cancelPairing')}
          </Button>
        ) : null}
      </Toolbar>
      {error ? <small className="db-form-error">{error}</small> : null}
      {pairing ? (
        <div className="db-record-summary" data-testid="adobe-bridge-pairing-code">
          <strong>{i18n.t('settings.adobeBridge.pairingCode', { code: pairing.code })}</strong>
          <small>{i18n.t('settings.adobeBridge.pairingExpires', { expiresAt: pairing.expiresAt })}</small>
        </div>
      ) : null}
      <div className="db-record-summary">
        <StatusPill tone={bridge.settings.discoveryStatus === 'available' || bridge.settings.discoveryStatus === 'disabled' ? 'neutral' : 'danger'}>
          {discoveryLabel(bridge.settings.discoveryStatus, i18n)}
        </StatusPill>
      </div>
      <div className="db-record-list">
        {bridge.clients.map((client) => {
          const linked = isPhotoshopLinkedToCurrentProject(bridge, currentProjectId, client.pluginInstanceId);
          const clientOperation = clientOperations[client.pluginInstanceId];
          const clientOperationLoading = clientOperation?.status === 'loading';
          return (
            <div className="db-record-row" key={client.pluginInstanceId}>
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
                      client.pluginInstanceId,
                      () => actions.unlinkAdobeBridgePhotoshop(client.pluginInstanceId)
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
                      client.pluginInstanceId,
                      () => actions.linkAdobeBridgePhotoshop({ pluginInstanceId: client.pluginInstanceId })
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
      <h3>{i18n.t('settings.adobeBridge.pairedPlugins')}</h3>
      <div className="db-record-list">
        {bridge.pairedPlugins.map((plugin) => (
          <div className="db-record-row" key={plugin.pluginInstanceId}>
            <span>{plugin.clientRuntime.toUpperCase()} · {plugin.pluginInstanceId}</span>
            <StatusPill tone="neutral">
              {i18n.t(plugin.connected ? 'settings.adobeBridge.connected' : 'settings.adobeBridge.disconnected')}
            </StatusPill>
            <small>{plugin.createdAt}</small>
            <div className="db-record-row__action">
              <Button
                type="button"
                iconStart={<Trash2 size={14} />}
                onClick={() => void runClientOperation(
                  plugin.pluginInstanceId,
                  () => actions.removeAdobeBridgePairing(plugin.pluginInstanceId)
                )}
              >
                {i18n.t('settings.adobeBridge.removePairing')}
              </Button>
            </div>
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
  pluginInstanceId: string
): boolean {
  if (!currentProjectId) {
    return false;
  }
  return bridge.links.some((link) => (
    link.projectId === currentProjectId
    && link.pluginInstanceId === pluginInstanceId
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
