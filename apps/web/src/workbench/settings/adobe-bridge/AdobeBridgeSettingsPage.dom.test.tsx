import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdobeBridgeStateView } from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../../types';
import { I18nProvider } from '../../i18n';
import { AdobeBridgeSettingsPage } from './AdobeBridgeSettingsPage';

describe('Adobe Bridge pairing UI', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates, atomically replaces, consumes, and explicitly cancels a pairing code', async () => {
    const createAdobeBridgePairing = vi.fn()
      .mockResolvedValueOnce(pairing('pairing-1', 'AAAA-BBBB-CCCC'))
      .mockResolvedValueOnce(pairing('pairing-2', 'DDDD-EEEE-FFFF'))
      .mockResolvedValueOnce(pairing('pairing-3', 'GGGG-HHHH-JJJJ'));
    const cancelAdobeBridgePairing = vi.fn(async () => undefined);
    const actions = pairingActions({ createAdobeBridgePairing, cancelAdobeBridgePairing });
    await renderPage(root, bridge(), actions);

    await click(container, 'Pair plugin');
    expect(container.textContent).toContain('AAAA-BBBB-CCCC');
    await click(container, 'Replace pairing code');
    expect(container.textContent).toContain('DDDD-EEEE-FFFF');
    expect(cancelAdobeBridgePairing).not.toHaveBeenCalled();

    await renderPage(root, bridge({
      pairedPlugins: [{
        pluginInstanceId: 'plugin-1',
        clientRuntime: 'uxp',
        createdAt: new Date().toISOString(),
        connected: true
      }]
    }), actions);
    expect(container.textContent).not.toContain('DDDD-EEEE-FFFF');

    await click(container, 'Pair plugin');
    await click(container, 'Cancel pairing');
    expect(cancelAdobeBridgePairing).toHaveBeenCalledWith('pairing-3');
    expect(container.textContent).not.toContain('GGGG-HHHH-JJJJ');
  });

  it('removes an expired code from the Workbench without retaining it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    const actions = pairingActions({
      createAdobeBridgePairing: vi.fn(async () => ({
        pairingId: 'pairing-1',
        code: 'AAAA-BBBB-CCCC',
        expiresAt: '2026-07-17T00:00:01.000Z'
      }))
    });
    await renderPage(root, bridge(), actions);
    await click(container, 'Pair plugin');
    expect(container.textContent).toContain('AAAA-BBBB-CCCC');

    await act(async () => vi.advanceTimersByTime(1_001));
    expect(container.textContent).not.toContain('AAAA-BBBB-CCCC');
  });
});

async function renderPage(root: Root, value: AdobeBridgeStateView, actions: WorkbenchActions): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider locale="en">
        <AdobeBridgeSettingsPage
          persistedSettings={{ enabled: true }}
          bridge={value}
          projectId="project-1"
          actions={actions}
        />
      </I18nProvider>
    );
  });
}

async function click(container: HTMLElement, label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Expected ${label} button.`);
  await act(async () => button.click());
}

function pairing(id: string, code: string): { pairingId: string; code: string; expiresAt: string } {
  return { pairingId: id, code, expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

function pairingActions(overrides: Partial<WorkbenchActions>): WorkbenchActions {
  return {
    saveGlobalSettings: async () => undefined,
    createAdobeBridgePairing: async () => pairing('default', 'AAAA-BBBB-CCCC'),
    cancelAdobeBridgePairing: async () => undefined,
    removeAdobeBridgePairing: async () => undefined,
    linkAdobeBridgePhotoshop: async () => undefined,
    unlinkAdobeBridgePhotoshop: async () => undefined,
    ...overrides
  } as unknown as WorkbenchActions;
}

function bridge(overrides: Partial<AdobeBridgeStateView> = {}): AdobeBridgeStateView {
  return {
    settings: { enabled: true, discoveryStatus: 'available' },
    pairedPlugins: [],
    clients: [],
    projects: [],
    links: [],
    transfers: [],
    ...overrides
  };
}
