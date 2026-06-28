import React from 'react';
import { Send, X } from 'lucide-react';
import type { AdobeBridgeClient, AdobeBridgeStateView } from '@debrute/app-protocol';
import { Button, StatusPill, Toolbar } from '../ui';
import { useI18n } from '../i18n';

export function SendToPhotoshopDialog({
  projectId,
  projectRelativePath,
  bridge,
  sending,
  onSend,
  onClose
}: {
  projectId: string;
  projectRelativePath: string;
  bridge: AdobeBridgeStateView | undefined;
  sending: boolean;
  onSend: (adobeClientId: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const i18n = useI18n();
  const linkedClients = linkedPhotoshopClients(bridge, projectId);
  return (
    <div className="db-modal-backdrop" role="presentation">
      <section className="db-modal" role="dialog" aria-modal="true" aria-label={i18n.t('adobeBridge.sendToPhotoshop.title')}>
        <header className="db-settings-section__header">
          <h2>{i18n.t('adobeBridge.sendToPhotoshop.title')}</h2>
          <Toolbar ariaLabel={i18n.t('adobeBridge.sendToPhotoshop.dialogActions')} className="db-action-row">
            <Button type="button" iconStart={<X size={14} />} onClick={onClose}>{i18n.t('common.close')}</Button>
          </Toolbar>
        </header>
        <small>{projectRelativePath}</small>
        <div className="db-integration-list">
          {linkedClients.map((client) => {
            const disabled = sending || client.activeDocumentTitle === null;
            return (
              <button
                key={client.adobeClientId}
                type="button"
                className="db-integration-row"
                disabled={disabled}
                onClick={() => onSend(client.adobeClientId)}
              >
                <span>{client.displayName}</span>
                {client.activeDocumentTitle ? <StatusPill tone="success">{i18n.t('adobeBridge.sendToPhotoshop.ready')}</StatusPill> : null}
                <small>{sending ? i18n.t('adobeBridge.sendToPhotoshop.sending') : ''}</small>
                <span className="db-integration-row__action"><Send size={14} /></span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export function linkedPhotoshopClients(
  bridge: AdobeBridgeStateView | undefined,
  projectId: string
): AdobeBridgeClient[] {
  if (!bridge?.settings.enabled) {
    return [];
  }
  const linkedClientIds = new Set(bridge.links
    .filter((link) => link.projectId === projectId && link.status === 'active')
    .map((link) => link.adobeClientId));
  return bridge.adobeClients.filter((client) => linkedClientIds.has(client.adobeClientId));
}
