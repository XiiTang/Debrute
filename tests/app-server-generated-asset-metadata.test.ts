import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DebruteAppServer } from '@debrute/app-server';

describe('app-server generated asset metadata', () => {
  it('records generated asset metadata and looks it up after the file is renamed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-app-server-generated-metadata-'));
    let server: DebruteAppServer | undefined;
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      server = new DebruteAppServer();
      await server.openProject(root, { initializeIfMissing: true, createDefaultCanvas: true });

      await server.recordGeneratedAssetMetadata({
        projectRelativePath: 'generated/cover.png',
        modelRun: { request: { prompt: 'cover' }, output: { ok: true } }
      });
      await rename(join(root, 'generated/cover.png'), join(root, 'generated/renamed-cover.png'));

      const lookup = await server.lookupGeneratedAssetMetadata({ projectRelativePath: 'generated/renamed-cover.png' });

      expect(lookup.status).toBe('matched');
      if (lookup.status === 'matched') {
        expect(lookup.records[0]).toMatchObject({
          schemaVersion: 1,
          modelRun: { request: { prompt: 'cover' }, output: { ok: true } }
        });
      }
    } finally {
      server?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
