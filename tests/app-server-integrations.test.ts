import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AxisAppServer, GlobalConfigStore } from '../apps/app-server/src/index';

describe('AxisAppServer integration settings', () => {
  it('emits an integrations settings change event after rescan', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-integrations-rescan-event-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-integrations-rescan-event-project-'));
    const server = new AxisAppServer({
      globalConfigStore: new GlobalConfigStore({ axisHome: home }),
      integrationEnvPath: ''
    });
    const events: string[] = [];
    server.onEvent((event) => events.push(event.type));

    try {
      await server.openProject(projectRoot);
      await server.integrationsRescan();

      expect(events).toContain('integrations.settings.changed');
    } finally {
      server.close();
    }
  });

});
