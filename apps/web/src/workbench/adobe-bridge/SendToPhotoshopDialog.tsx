import React from 'react';
import { Send, X } from 'lucide-react';
import type { AdobeBridgeClient, AdobeBridgeStateView } from '@debrute/app-protocol';
import { Button, EmptyState, StatusPill, Toolbar } from '../ui';
import { useI18n } from '../i18n';

export function SendToPhotoshopDialog({
  projectId,
  projectRelativePath,
  enabled,
  bridge,
  sending,
  onSend,
  onClose
}: {
  projectId: string;
  projectRelativePath: string;
  enabled: boolean;
  bridge: AdobeBridgeStateView | undefined;
  sending: boolean;
  onSend: (adobeClientId: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const i18n = useI18n();
  const linkedClients = linkedPhotoshopClients(bridge, projectId, enabled);
  return (
    <div className="db-modal-backdrop" role="presentation">
      <section className="db-modal" role="dialog" aria-modal="true" aria-label={i18n.t('adobeBridge.sendToPhotoshop.title')}>
        <header className="db-surface-header">
          <h2>{i18n.t('adobeBridge.sendToPhotoshop.title')}</h2>
          <Toolbar ariaLabel={i18n.t('adobeBridge.sendToPhotoshop.dialogActions')} className="db-action-row">
            <Button type="button" iconStart={<X size={14} />} onClick={onClose}>{i18n.t('common.close')}</Button>
          </Toolbar>
        </header>
        <small>{projectRelativePath}</small>
        <div className="db-record-list">
          {linkedClients.length === 0 ? (
            <EmptyState title={i18n.t('adobeBridge.sendToPhotoshop.noLinkedClients')} />
          ) : (
            linkedClients.map((client) => {
              const disabled = sending || client.activeDocumentTitle === null;
              return (
                <button
                  key={client.adobeClientId}
                  type="button"
                  className="db-record-row"
                  disabled={disabled}
                  onClick={() => onSend(client.adobeClientId)}
                >
                  <span>{client.displayName}</span>
                  {client.activeDocumentTitle ? <StatusPill tone="neutral">{i18n.t('adobeBridge.sendToPhotoshop.ready')}</StatusPill> : null}
                  <small>{sending ? i18n.t('adobeBridge.sendToPhotoshop.sending') : ''}</small>
                  <span className="db-record-row__action"><Send size={14} /></span>
                </button>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

export function linkedPhotoshopClients(
  bridge: AdobeBridgeStateView | undefined,
  projectId: string,
  enabled: boolean
): AdobeBridgeClient[] {
  if (!enabled || !bridge) {
    return [];
  }
  const linkedClientIds = new Set(bridge.links
    .filter((link) => link.projectId === projectId && link.status === 'active')
    .map((link) => link.adobeClientId));
  return bridge.adobeClients.filter((client) => linkedClientIds.has(client.adobeClientId));
}
