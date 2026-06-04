import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AxisGlobalRuntimeServer, GlobalConfigStore } from '../apps/app-server/src/index';

describe('AxisGlobalRuntimeServer integration settings', () => {
  it('emits an integrations settings change event after rescan', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-integrations-rescan-event-home-'));
    const globalRuntime = new AxisGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ axisHome: home }),
      integrationEnvPath: ''
    });
    const events: string[] = [];
    globalRuntime.onEvent((event) => events.push(event.type));

    try {
      await globalRuntime.integrationsRescan();

      expect(events).toContain('integrations.settings.changed');
    } finally {
      globalRuntime.close();
      await rm(home, { recursive: true, force: true });
    }
  });

});
