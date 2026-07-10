import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DebruteGlobalRuntimeServer, GlobalConfigStore } from '../apps/app-server/src/index';

describe('Adobe Bridge global settings', () => {
  it('defaults enabled, persists disabled, and emits a settings event', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-adobe-bridge-settings-'));
    const globalConfigStore = new GlobalConfigStore({ debruteHome: home });
    const runtime = new DebruteGlobalRuntimeServer({ globalConfigStore, integrationEnvPath: '' });
    const events: string[] = [];
    runtime.onEvent((event) => events.push(event.type));

    try {
      await expect(runtime.adobeBridgeGetPersistedSettings()).resolves.toEqual({ enabled: true });

      await expect(runtime.globalSettingsSave({ adobeBridge: { enabled: false } })).resolves.toMatchObject({
        adobeBridge: {
          enabled: false
        }
      });

      expect(events).toContain('globalSettings.changed');
      const config = JSON.parse(await readFile(join(home, 'config/global_settings.json'), 'utf8')) as {
        adobeBridge: { enabled: boolean };
      };
      expect(config.adobeBridge).toEqual({ enabled: false });
    } finally {
      runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
