import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adobeBridgeClientDisplayName,
  isAdobeBridgeErrorCode,
  type AdobeBridgeClient,
  type AdobeBridgeStateView
} from '@debrute/app-protocol';

describe('Adobe Bridge protocol', () => {
  it('derives Photoshop client display names from host and document state', () => {
    expect(adobeBridgeClientDisplayName({
      hostApp: 'photoshop',
      hostVersion: '2026',
      activeDocumentTitle: 'poster.psd'
    })).toBe('Photoshop 2026 · poster.psd');

    expect(adobeBridgeClientDisplayName({
      hostApp: 'photoshop',
      hostVersion: '2026',
      activeDocumentTitle: null
    })).toBe('Photoshop 2026 · No document open');
  });

  it('keeps the bridge state shape stable', () => {
    const client: AdobeBridgeClient = {
      adobeClientId: 'ps-client-1',
      hostApp: 'photoshop',
      hostVersion: '2026',
      displayName: 'Photoshop 2026 · No document open',
      documentCount: 0,
      activeDocumentTitle: null,
      connectedAt: '2026-06-18T00:00:00.000Z',
      lastSeenAt: '2026-06-18T00:00:01.000Z'
    };

    const state: AdobeBridgeStateView = {
      settings: { enabled: true, discoveryStatus: 'available' },
      adobeClients: [client],
      projects: [],
      links: [],
      transfers: []
    };

    expect(state.adobeClients[0]?.displayName).toBe('Photoshop 2026 · No document open');
    expect(state.settings.discoveryStatus).toBe('available');
  });

  it('recognizes only stable bridge error codes', () => {
    expect(isAdobeBridgeErrorCode('project_not_linked')).toBe(true);
    expect(isAdobeBridgeErrorCode('photoshop_place_failed')).toBe(true);
    expect(isAdobeBridgeErrorCode('old_bridge_code')).toBe(false);
  });

  it('does not carry an unused Photoshop export-result WebSocket protocol', () => {
    const protocolSource = readFileSync(join(process.cwd(), 'packages/app-protocol/src/index.ts'), 'utf8');

    expect(protocolSource).not.toContain('PhotoshopBridgeExportResultMessage');
    expect(protocolSource).not.toContain('transfer.export.result');
  });
});
