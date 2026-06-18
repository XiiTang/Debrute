import React from 'react';
import { Send, X } from 'lucide-react';
import type { AdobeBridgeClient, AdobeBridgeStateView } from '@debrute/app-protocol';
import { Button, StatusPill, Toolbar } from '../ui';

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
  const linkedClients = linkedPhotoshopClients(bridge, projectId);
  return (
    <div className="db-modal-backdrop" role="presentation">
      <section className="db-modal" role="dialog" aria-modal="true" aria-label="Send to Photoshop">
        <header className="settings-section-header">
          <h2>Send to Photoshop</h2>
          <Toolbar ariaLabel="Dialog actions" className="settings-actions">
            <Button type="button" iconStart={<X size={14} />} onClick={onClose}>Close</Button>
          </Toolbar>
        </header>
        <small>{projectRelativePath}</small>
        <div className="integrations-list">
          {linkedClients.map((client) => {
            const disabled = sending || client.activeDocumentTitle === null;
            return (
              <button
                key={client.adobeClientId}
                type="button"
                className="integration-row adobe-bridge-target-row"
                disabled={disabled}
                onClick={() => onSend(client.adobeClientId)}
              >
                <span>{client.displayName}</span>
                {client.activeDocumentTitle ? <StatusPill tone="success">Ready</StatusPill> : null}
                <small>{sending ? 'Sending' : ''}</small>
                <span className="integration-row-action"><Send size={14} /></span>
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
