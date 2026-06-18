import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DebruteGlobalRuntimeServer, GlobalConfigStore } from '../apps/app-server/src/index';

describe('Adobe Bridge global settings', () => {
  it('defaults enabled, persists disabled, and emits a settings event', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-adobe-bridge-settings-'));
    const globalConfigStore = new GlobalConfigStore({ debruteHome: home });
    const runtime = new DebruteGlobalRuntimeServer({ globalConfigStore });
    const events: string[] = [];
    runtime.onEvent((event) => events.push(event.type));

    try {
      await expect(runtime.adobeBridgeGetSettings()).resolves.toEqual({
        enabled: true,
        discoveryStatus: 'unavailable'
      });

      await expect(runtime.adobeBridgeSaveSettings({ enabled: false })).resolves.toEqual({
        enabled: false,
        discoveryStatus: 'disabled'
      });

      expect(events).toContain('adobeBridge.settings.changed');
      const config = JSON.parse(await readFile(join(home, 'config/adobe_bridge.json'), 'utf8')) as { enabled: boolean };
      expect(config).toEqual({ enabled: false });
    } finally {
      runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
