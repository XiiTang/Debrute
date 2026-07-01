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
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: { request: { prompt: 'cover' }, output: { ok: true } }
      });
      await rename(join(root, 'generated/cover.png'), join(root, 'generated/renamed-cover.png'));

      const lookup = await server.lookupGeneratedAssetMetadata({ projectRelativePath: 'generated/renamed-cover.png' });

      expect(lookup.status).toBe('matched');
      if (lookup.status === 'matched') {
        expect(lookup.records[0]).toMatchObject({
          modelRun: { request: { prompt: 'cover' }, output: { ok: true } }
        });
      }
    } finally {
      server?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports fingerprint cache write failure without failing generated asset metadata writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-app-server-generated-cache-diagnostic-'));
    let server: DebruteAppServer | undefined;
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      server = new DebruteAppServer();
      await server.openProject(root, { initializeIfMissing: true, createDefaultCanvas: true });
      await mkdir(join(root, '.debrute/cache/file-fingerprints.json'), { recursive: true });

      const record = await server.recordGeneratedAssetMetadata({
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: { request: { prompt: 'cover' }, output: { ok: true } }
      });

      const snapshot = server.getSnapshot();
      expect(record).toMatchObject({ projectRelativePath: 'generated/cover.png' });
      expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'project',
          severity: 'warning',
          code: 'generated_asset_fingerprint_cache_write_failed',
          filePath: join(root, '.debrute/cache/file-fingerprints.json')
        })
      ]));
      expect(snapshot.health.diagnosticCounts.warnings).toBeGreaterThan(0);
    } finally {
      server?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
