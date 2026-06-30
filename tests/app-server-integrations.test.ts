import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DebruteGlobalRuntimeServer, GlobalConfigStore } from '../apps/app-server/src/index';

describe('DebruteGlobalRuntimeServer integration settings', () => {
  it('emits an integrations settings change event after rescan', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-integrations-rescan-event-home-'));
    const globalRuntime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
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

  it('emits integration settings events when an operation starts and settles', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-integrations-operation-event-home-'));
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-operation-event-bin-'));
    const magickPath = join(binDir, 'magick');
    await writeFakePackageManager(binDir, 'brew', [
      'if [ "$1" = "info" ]; then',
      '  printf \'{"formulae":[{"name":"imagemagick","versions":{"stable":"7.1.2-23"},"installed":[]}],"casks":[]}\\n\'',
      'fi',
      'if [ "$1" = "install" ]; then',
      `  printf '%s\\n' '#!/bin/sh' 'printf "Version: ImageMagick 7.1.2-23\\n"' > ${JSON.stringify(magickPath)}`,
      `  chmod +x ${JSON.stringify(magickPath)}`,
      'fi'
    ].join('\n'));
    const globalRuntime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
      integrationEnvPath: binDir,
      integrationPlatform: 'darwin'
    });
    const events: Array<{ type: string; settings?: { runningOperation?: unknown } }> = [];
    globalRuntime.onEvent((event) => events.push(event));

    try {
      const result = await globalRuntime.integrationsRunOperation({ integrationId: 'imagemagick', operation: 'install' });

      expect(result.ok).toBe(true);
      expect(events.filter((event) => event.type === 'integrations.settings.changed')).toHaveLength(2);
      expect(events[0]?.settings?.runningOperation).toEqual({ integrationId: 'imagemagick', operation: 'install' });
      expect(events.at(-1)?.settings?.runningOperation).toBeUndefined();
    } finally {
      globalRuntime.close();
      await rm(home, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not emit running integration events for unavailable operations', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-integrations-unavailable-event-home-'));
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-unavailable-event-bin-'));
    await writeFakePackageManager(binDir, 'brew', [
      'if [ "$1" = "info" ]; then',
      '  printf \'{"formulae":[{"name":"imagemagick","versions":{"stable":"7.1.2-23"},"installed":[]}],"casks":[]}\\n\'',
      'fi'
    ].join('\n'));
    const globalRuntime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
      integrationEnvPath: binDir,
      integrationPlatform: 'darwin'
    });
    const events: Array<{ type: string; settings?: { runningOperation?: unknown; integrations?: unknown[] } }> = [];
    globalRuntime.onEvent((event) => events.push(event));

    try {
      const result = await globalRuntime.integrationsRunOperation({ integrationId: 'imagemagick', operation: 'uninstall' });

      expect(result).toMatchObject({
        ok: false,
        diagnostic: { errorKind: 'operation_unavailable' }
      });
      expect(result.settings.runningOperation).toBeUndefined();
      expect(result.settings.integrations).not.toHaveLength(0);
      expect(events.filter((event) => event.type === 'integrations.settings.changed')).toEqual([]);
    } finally {
      globalRuntime.close();
      await rm(home, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  }, 20_000);

});

async function writeFakePackageManager(dir: string, name: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, ['#!/bin/sh', body].join('\n'), 'utf8');
  await chmod(path, 0o755);
  return path;
}
