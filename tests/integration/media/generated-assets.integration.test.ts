import { createGeneratedAssetMetadataService, generatedAssetMetadataPaths } from '../../../apps/app-server/src/generated-assets/GeneratedAssetMetadataService';
import { commitProjectDocumentTransaction } from '../../../apps/app-server/src/project-documents/ProjectDocumentTransaction';
import { DebruteAppServer } from '@debrute/app-server';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

describe('generated asset metadata service', () => {
  it('keeps generated asset index unchanged when record id validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-asset-tx-'));
    const service = createGeneratedAssetMetadataService({
      createRecordId: () => '../escape',
      now: () => '2026-06-15T00:00:00.000Z'
    });
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), 'fake', 'utf8');

      await expect(service.recordGeneratedAsset(root, {
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: { request: {}, output: {} }
      })).rejects.toThrow('Invalid generated asset record id');

      await expect(readFile(join(root, '.debrute/assets/generated-assets-index.json'), 'utf8')).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records complete model run provenance in a per-record file and keeps the index lightweight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-final-shape-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const service = createGeneratedAssetMetadataService({
        now: () => '2026-05-24T00:00:00.000Z',
        createRecordId: () => 'record-1'
      });

      const record = await service.recordGeneratedAsset(root, {
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: {
          request: { method: 'POST', url: 'https://model.example/images', body: { prompt: 'cover' } },
          output: { status: 200, body: { data: [{ b64_json: 'full-model-output' }] } }
        }
      });

      const paths = generatedAssetMetadataPaths(root);
      const index = await readJson(paths.indexFile);
      const recordFile = await readJson(join(paths.recordsDir, 'record-1.json'));
      const cache = await readJson(paths.cacheFile);

      expect(record).toEqual({
        recordId: 'record-1',
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        createdAt: '2026-05-24T00:00:00.000Z',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        fingerprint: { algorithm: 'sha256', hash: sha256('image-bytes') },
        modelRun: {
          request: { method: 'POST', url: 'https://model.example/images', body: { prompt: 'cover' } },
          output: { status: 200, body: { data: [{ b64_json: 'full-model-output' }] } }
        }
      });
      expect(index).toEqual({
        records: [
          {
            recordId: 'record-1',
            modelRunId: 'model-run-1',
            artifactRole: 'primary-image',
            artifactIndex: 0,
            createdAt: '2026-05-24T00:00:00.000Z',
            fingerprint: { algorithm: 'sha256', hash: sha256('image-bytes') },
            metadataPath: '.debrute/assets/generated/record-1.json'
          }
        ]
      });
      expect(JSON.stringify(index)).not.toContain('https://model.example/images');
      expect(JSON.stringify(index)).not.toContain('full-model-output');
      expect(recordFile).toEqual(record);
      expect(cache).toMatchObject({
        entries: {
          'generated/cover.png': {
            sizeBytes: 11,
            sha256: sha256('image-bytes'),
            computedAt: '2026-05-24T00:00:00.000Z'
          }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records video and last-frame artifacts under one model run id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-video-run-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/clip.mp4'), Buffer.from('video-bytes'));
      await writeFile(join(root, 'generated/clip-last.png'), Buffer.from('last-frame-bytes'));
      let counter = 0;
      const service = createGeneratedAssetMetadataService({
        now: () => `2026-06-30T00:00:0${counter}.000Z`,
        createRecordId: () => `record-${counter += 1}`
      });

      await service.recordGeneratedAsset(root, {
        modelRunId: 'video-run-1',
        projectRelativePath: 'generated/clip.mp4',
        artifactRole: 'primary-video',
        artifactIndex: 0,
        modelRun: { request: { prompt: 'clip' }, output: { artifactIndex: 0 } }
      });
      await service.recordGeneratedAsset(root, {
        modelRunId: 'video-run-1',
        projectRelativePath: 'generated/clip-last.png',
        artifactRole: 'last-frame',
        artifactIndex: 1,
        modelRun: { request: { prompt: 'clip' }, output: { artifactIndex: 1 } }
      });

      const videoLookup = await service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/clip.mp4' });
      const frameLookup = await service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/clip-last.png' });

      expect(videoLookup.status).toBe('matched');
      expect(frameLookup.status).toBe('matched');
      if (videoLookup.status === 'matched' && frameLookup.status === 'matched') {
        expect(videoLookup.records[0]).toMatchObject({
          modelRunId: 'video-run-1',
          artifactRole: 'primary-video',
          artifactIndex: 0
        });
        expect(frameLookup.records[0]).toMatchObject({
          modelRunId: 'video-run-1',
          artifactRole: 'last-frame',
          artifactIndex: 1
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('aborts generated asset metadata when the index changes before commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-index-conflict-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const paths = generatedAssetMetadataPaths(root);
      let injectedConflict = false;
      const service = createGeneratedAssetMetadataService({
        now: () => '2026-05-24T00:00:00.000Z',
        createRecordId: () => 'record-1',
        writeStructuredDocuments: async (input) => {
          if (!injectedConflict) {
            injectedConflict = true;
            await mkdir(join(root, '.debrute/assets'), { recursive: true });
            await writeFile(paths.indexFile, JSON.stringify({
              records: [{
                recordId: 'external-record',
                modelRunId: 'external-run-1',
                artifactRole: 'primary-image',
                artifactIndex: 0,
                createdAt: '2026-05-24T00:00:01.000Z',
                fingerprint: { algorithm: 'sha256', hash: sha256('external') },
                metadataPath: '.debrute/assets/generated/external-record.json'
              }]
            }, null, 2), 'utf8');
          }
          await commitProjectDocumentTransaction(input);
        }
      });

      await expect(service.recordGeneratedAsset(root, {
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: { request: {}, output: {} }
      })).rejects.toMatchObject({ code: 'document_push_conflict' });
      await expect(readFile(join(paths.recordsDir, 'record-1.json'), 'utf8')).rejects.toBeDefined();
      expect(await readJson(paths.indexFile)).toMatchObject({
        records: [{ recordId: 'external-record' }]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps generated asset record and index when the fingerprint cache write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-cache-failure-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const paths = generatedAssetMetadataPaths(root);
      const diagnostics: Array<{ code: string; message: string; metadataPath?: string }> = [];
      const service = createGeneratedAssetMetadataService({
        now: () => '2026-05-24T00:00:00.000Z',
        createRecordId: () => 'record-1',
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        writeStructuredDocuments: async (input) => {
          if (input.writes.some((write) => write.absolutePath === paths.cacheFile)) {
            throw new Error('cache directory is unavailable');
          }
          await commitProjectDocumentTransaction(input);
        }
      });

      const record = await service.recordGeneratedAsset(root, {
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: { request: {}, output: {} }
      });

      expect(record.recordId).toBe('record-1');
      expect(await readJson(join(paths.recordsDir, 'record-1.json'))).toEqual(record);
      expect(await readJson(paths.indexFile)).toMatchObject({
        records: [{ recordId: 'record-1' }]
      });
      expect(diagnostics).toEqual([
        {
          code: 'generated_asset_fingerprint_cache_write_failed',
          message: 'cache directory is unavailable',
          metadataPath: '.debrute/cache/file-fingerprints.json'
        }
      ]);
      await expect(readFile(paths.cacheFile, 'utf8')).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps generated asset lookup available when the fingerprint cache write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-lookup-cache-failure-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const paths = generatedAssetMetadataPaths(root);
      const diagnostics: Array<{ code: string; message: string; metadataPath?: string }> = [];
      const service = createGeneratedAssetMetadataService({
        now: () => '2026-05-24T00:00:00.000Z',
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        writeStructuredDocuments: async (input) => {
          if (input.writes.some((write) => write.absolutePath === paths.cacheFile)) {
            throw new Error('cache directory is unavailable');
          }
          await commitProjectDocumentTransaction(input);
        }
      });

      const lookup = await service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/cover.png' });

      expect(lookup).toMatchObject({
        status: 'unmatched',
        fingerprint: { algorithm: 'sha256', hash: sha256('image-bytes') },
        diagnostics: [
          {
            code: 'generated_asset_fingerprint_cache_write_failed',
            message: 'cache directory is unavailable',
            metadataPath: '.debrute/cache/file-fingerprints.json'
          }
        ]
      });
      expect(diagnostics).toEqual([
        {
          code: 'generated_asset_fingerprint_cache_write_failed',
          message: 'cache directory is unavailable',
          metadataPath: '.debrute/cache/file-fingerprints.json'
        }
      ]);
      await expect(readFile(paths.cacheFile, 'utf8')).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('matches metadata by SHA-256 after the generated file is renamed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-rename-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const service = createGeneratedAssetMetadataService({
        now: () => '2026-05-24T00:00:00.000Z',
        createRecordId: () => 'record-1'
      });

      await service.recordGeneratedAsset(root, {
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: { request: { prompt: 'cover' }, output: { ok: true, raw: 'complete' } }
      });
      await rename(join(root, 'generated/cover.png'), join(root, 'generated/renamed-cover.png'));

      const lookup = await service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/renamed-cover.png' });

      expect(lookup.status).toBe('matched');
      if (lookup.status === 'matched') {
        expect(lookup.fingerprint.hash).toBe(sha256('image-bytes'));
        expect(lookup.records).toEqual([
          {
            recordId: 'record-1',
            modelRunId: 'model-run-1',
            projectRelativePath: 'generated/cover.png',
            createdAt: '2026-05-24T00:00:00.000Z',
            artifactRole: 'primary-image',
            artifactIndex: 0,
            fingerprint: { algorithm: 'sha256', hash: sha256('image-bytes') },
            modelRun: { request: { prompt: 'cover' }, output: { ok: true, raw: 'complete' } }
          }
        ]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves generated asset raw paths by SHA-256 after rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-raw-rename-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const service = createGeneratedAssetMetadataService({
        now: () => '2026-05-24T00:00:00.000Z',
        createRecordId: () => 'record-1'
      });

      const record = await service.recordGeneratedAsset(root, {
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: { request: { prompt: 'cover' }, output: { ok: true } }
      });
      await rename(join(root, 'generated/cover.png'), join(root, 'generated/renamed-cover.png'));

      await expect(service.resolveGeneratedAssetRawPath(root, record.recordId))
        .resolves.toBe(await realpath(join(root, 'generated/renamed-cover.png')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns every matching metadata record newest first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-duplicates-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('same-output'));
      let counter = 0;
      const service = createGeneratedAssetMetadataService({
        now: () => `2026-05-24T00:00:0${counter}.000Z`,
        createRecordId: () => `record-${counter += 1}`
      });

      await service.recordGeneratedAsset(root, {
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: { request: { prompt: 'first' }, output: { seed: 1 } }
      });
      await service.recordGeneratedAsset(root, {
        modelRunId: 'model-run-2',
        projectRelativePath: 'generated/cover.png',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: { request: { prompt: 'second' }, output: { seed: 2 } }
      });

      const lookup = await service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/cover.png' });

      expect(lookup.status).toBe('matched');
      if (lookup.status === 'matched') {
        expect(lookup.records.map((item) => item.recordId)).toEqual(['record-2', 'record-1']);
        expect(lookup.records.map((item) => item.modelRun.request)).toEqual([{ prompt: 'second' }, { prompt: 'first' }]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips a missing matching record file and returns diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-missing-record-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const service = createGeneratedAssetMetadataService({
        now: () => '2026-05-24T00:00:00.000Z',
        createRecordId: () => 'record-1'
      });

      await service.recordGeneratedAsset(root, {
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: { request: { prompt: 'cover' }, output: { ok: true } }
      });
      await unlink(join(generatedAssetMetadataPaths(root).recordsDir, 'record-1.json'));

      const lookup = await service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/cover.png' });

      expect(lookup).toMatchObject({
        status: 'unmatched',
        fingerprint: { algorithm: 'sha256', hash: sha256('image-bytes') },
        diagnostics: [
          {
            code: 'generated_asset_metadata_record_unreadable',
            recordId: 'record-1',
            metadataPath: '.debrute/assets/generated/record-1.json'
          }
        ]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats a missing metadata index and fingerprint cache as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-empty-index-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const service = createGeneratedAssetMetadataService({
        now: () => '2026-05-24T00:00:00.000Z'
      });

      const lookup = await service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/cover.png' });
      const cache = await readJson(generatedAssetMetadataPaths(root).cacheFile);

      expect(lookup).toEqual({
        status: 'unmatched',
        fingerprint: { algorithm: 'sha256', hash: sha256('image-bytes') }
      });
      expect(cache).toMatchObject({
        entries: {
          'generated/cover.png': {
            sha256: sha256('image-bytes'),
            computedAt: '2026-05-24T00:00:00.000Z'
          }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a corrupt fingerprint cache instead of silently rebuilding it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-corrupt-cache-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await mkdir(join(root, '.debrute/cache'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      await writeFile(join(root, '.debrute/cache/file-fingerprints.json'), '{not-json', 'utf8');
      const service = createGeneratedAssetMetadataService();

      await expect(service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/cover.png' }))
        .rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid fingerprint cache entries instead of dropping them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-invalid-cache-entry-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await mkdir(join(root, '.debrute/cache'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const fileStat = await stat(join(root, 'generated/cover.png'));
      await writeFile(join(root, '.debrute/cache/file-fingerprints.json'), JSON.stringify({
        entries: {
          'generated/cover.png': {
            sizeBytes: fileStat.size,
            mtimeMs: fileStat.mtimeMs,
            sha256: 'not-a-sha256',
            computedAt: '2026-05-24T00:00:00.000Z'
          }
        }
      }, null, 2), 'utf8');
      const service = createGeneratedAssetMetadataService({
        now: () => '2026-05-24T00:00:01.000Z'
      });

      await expect(service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/cover.png' }))
        .rejects.toThrow('Invalid generated asset fingerprint cache entry');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns metadata_unreadable when the metadata index is corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-corrupt-index-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await mkdir(join(root, '.debrute/assets'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      await writeFile(join(root, '.debrute/assets/generated-assets-index.json'), '{not-json', 'utf8');
      const service = createGeneratedAssetMetadataService();

      const lookup = await service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/cover.png' });

      expect(lookup.status).toBe('unavailable');
      if (lookup.status === 'unavailable') {
        expect(lookup.reason).toBe('metadata_unreadable');
        expect(lookup.message).toContain('Unable to read generated asset metadata index');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns metadata_unreadable when an index metadataPath is outside the generated metadata directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-invalid-path-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await mkdir(join(root, '.debrute/assets'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const fingerprint = { algorithm: 'sha256' as const, hash: sha256('image-bytes') };
      await writeFile(join(root, 'generated/not-metadata.json'), JSON.stringify({
        recordId: 'record-1',
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        createdAt: '2026-05-24T00:00:00.000Z',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        fingerprint,
        modelRun: { request: { prompt: 'outside' }, output: { ok: true } }
      }, null, 2), 'utf8');
      await writeFile(join(root, '.debrute/assets/generated-assets-index.json'), JSON.stringify({
        records: [
          {
            recordId: 'record-1',
            modelRunId: 'model-run-1',
            artifactRole: 'primary-image',
            artifactIndex: 0,
            createdAt: '2026-05-24T00:00:00.000Z',
            fingerprint,
            metadataPath: 'generated/not-metadata.json'
          }
        ]
      }, null, 2), 'utf8');
      const service = createGeneratedAssetMetadataService();

      const lookup = await service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/cover.png' });

      expect(lookup.status).toBe('unavailable');
      if (lookup.status === 'unavailable') {
        expect(lookup.reason).toBe('metadata_unreadable');
        expect(lookup.message).toContain('Invalid generated asset metadata index entry');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns metadata_unreadable when an index metadataPath is outside the generated asset record descriptor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-nested-record-path-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await mkdir(join(root, '.debrute/assets/generated/nested'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const fingerprint = { algorithm: 'sha256' as const, hash: sha256('image-bytes') };
      await writeFile(join(root, '.debrute/assets/generated/nested/record-1.json'), JSON.stringify({
        recordId: 'record-1',
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        createdAt: '2026-05-24T00:00:00.000Z',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        fingerprint,
        modelRun: { request: { prompt: 'nested' }, output: { ok: true } }
      }, null, 2), 'utf8');
      await writeFile(join(root, '.debrute/assets/generated-assets-index.json'), JSON.stringify({
        records: [
          {
            recordId: 'record-1',
            modelRunId: 'model-run-1',
            artifactRole: 'primary-image',
            artifactIndex: 0,
            createdAt: '2026-05-24T00:00:00.000Z',
            fingerprint,
            metadataPath: '.debrute/assets/generated/nested/record-1.json'
          }
        ]
      }, null, 2), 'utf8');
      const service = createGeneratedAssetMetadataService();

      const lookup = await service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/cover.png' });

      expect(lookup.status).toBe('unavailable');
      if (lookup.status === 'unavailable') {
        expect(lookup.reason).toBe('metadata_unreadable');
        expect(lookup.message).toContain('Invalid generated asset metadata index entry');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips a matching index entry when the record fingerprint does not match the entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-record-fingerprint-mismatch-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await mkdir(join(root, '.debrute/assets/generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      await writeFile(join(root, '.debrute/assets/generated/record-1.json'), JSON.stringify({
        recordId: 'record-1',
        modelRunId: 'model-run-1',
        projectRelativePath: 'generated/cover.png',
        createdAt: '2026-05-24T00:00:00.000Z',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        fingerprint: { algorithm: 'sha256', hash: sha256('different-image-bytes') },
        modelRun: { request: { prompt: 'cover' }, output: { ok: true } }
      }, null, 2), 'utf8');
      await writeFile(join(root, '.debrute/assets/generated-assets-index.json'), JSON.stringify({
        records: [
          {
            recordId: 'record-1',
            modelRunId: 'model-run-1',
            artifactRole: 'primary-image',
            artifactIndex: 0,
            createdAt: '2026-05-24T00:00:00.000Z',
            fingerprint: { algorithm: 'sha256', hash: sha256('image-bytes') },
            metadataPath: '.debrute/assets/generated/record-1.json'
          }
        ]
      }, null, 2), 'utf8');
      const service = createGeneratedAssetMetadataService();

      const lookup = await service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/cover.png' });

      expect(lookup).toMatchObject({
        status: 'unmatched',
        fingerprint: { algorithm: 'sha256', hash: sha256('image-bytes') },
        diagnostics: [
          {
            code: 'generated_asset_metadata_record_unreadable',
            recordId: 'record-1',
            metadataPath: '.debrute/assets/generated/record-1.json'
          }
        ]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats missing and unreadable selected files as unavailable lookup results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-generated-metadata-missing-file-'));
    try {
      const service = createGeneratedAssetMetadataService();

      await expect(service.lookupGeneratedAssetMetadata(root, { projectRelativePath: '../outside.png' }))
        .rejects.toThrow('Project path must not contain "." or ".." segments');
      await expect(service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'missing.png' })).resolves.toMatchObject({
        status: 'unavailable',
        reason: 'missing'
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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
