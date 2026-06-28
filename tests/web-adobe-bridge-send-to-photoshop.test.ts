import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AdobeBridgeStateView } from '@debrute/app-protocol';
import { describe, expect, it } from 'vitest';
import { SendToPhotoshopDialog } from '../apps/web/src/workbench/adobe-bridge/SendToPhotoshopDialog';
import { I18nProvider } from '../apps/web/src/workbench/i18n';

describe('SendToPhotoshopDialog', () => {
  it('lists only linked Photoshop clients and disables no-document clients', () => {
    const html = renderToStaticMarkup(
      React.createElement(I18nProvider, { locale: 'en' }, React.createElement(SendToPhotoshopDialog, {
        projectId: 'project-1',
        projectRelativePath: 'assets/cover.png',
        bridge: bridgeState(),
        sending: false,
        onSend: () => undefined,
        onClose: () => undefined
      }))
    );

    expect(html).toContain('Photoshop 2026 · poster.psd');
    expect(html).toContain('Photoshop 2026 · No document open');
    expect(html).not.toContain('Unlinked Photoshop');
    expect(html).toContain('disabled=""');
  });
});

function bridgeState(): AdobeBridgeStateView {
  return {
    settings: { enabled: true, discoveryStatus: 'available' },
    adobeClients: [
      {
        adobeClientId: 'ps-open',
        hostApp: 'photoshop',
        hostVersion: '2026',
        displayName: 'Photoshop 2026 · poster.psd',
        documentCount: 1,
        activeDocumentTitle: 'poster.psd',
        connectedAt: '2026-06-18T00:00:00.000Z',
        lastSeenAt: '2026-06-18T00:00:01.000Z'
      },
      {
        adobeClientId: 'ps-empty',
        hostApp: 'photoshop',
        hostVersion: '2026',
        displayName: 'Photoshop 2026 · No document open',
        documentCount: 0,
        activeDocumentTitle: null,
        connectedAt: '2026-06-18T00:00:00.000Z',
        lastSeenAt: '2026-06-18T00:00:01.000Z'
      },
      {
        adobeClientId: 'ps-unlinked',
        hostApp: 'photoshop',
        hostVersion: '2026',
        displayName: 'Unlinked Photoshop',
        documentCount: 1,
        activeDocumentTitle: 'other.psd',
        connectedAt: '2026-06-18T00:00:00.000Z',
        lastSeenAt: '2026-06-18T00:00:01.000Z'
      }
    ],
    projects: [],
    links: [
      { linkId: 'link-open', projectId: 'project-1', adobeClientId: 'ps-open', createdAt: '2026-06-18T00:00:01.000Z', status: 'active' },
      { linkId: 'link-empty', projectId: 'project-1', adobeClientId: 'ps-empty', createdAt: '2026-06-18T00:00:01.000Z', status: 'active' }
    ],
    transfers: []
  };
}
