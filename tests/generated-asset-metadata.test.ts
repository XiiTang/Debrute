import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createGeneratedAssetMetadataService,
  generatedAssetMetadataPaths
} from '../apps/app-server/src/generated-assets/GeneratedAssetMetadataService';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

describe('generated asset metadata service', () => {
  it('records complete model run provenance in a per-record file and keeps the index lightweight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-generated-metadata-final-shape-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const service = createGeneratedAssetMetadataService({
        now: () => '2026-05-24T00:00:00.000Z',
        createRecordId: () => 'record-1'
      });

      const record = await service.recordGeneratedAsset(root, {
        projectRelativePath: 'generated/cover.png',
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
	        schemaVersion: 1,
	        recordId: 'record-1',
	        projectRelativePath: 'generated/cover.png',
	        createdAt: '2026-05-24T00:00:00.000Z',
        fingerprint: { algorithm: 'sha256', hash: sha256('image-bytes') },
        modelRun: {
          request: { method: 'POST', url: 'https://model.example/images', body: { prompt: 'cover' } },
          output: { status: 200, body: { data: [{ b64_json: 'full-model-output' }] } }
        }
      });
      expect(index).toEqual({
        schemaVersion: 1,
        records: [
          {
            recordId: 'record-1',
            createdAt: '2026-05-24T00:00:00.000Z',
            fingerprint: { algorithm: 'sha256', hash: sha256('image-bytes') },
            metadataPath: '.axis/assets/generated/record-1.json'
          }
        ]
      });
      expect(JSON.stringify(index)).not.toContain('modelRun');
      expect(JSON.stringify(index)).not.toContain('full-model-output');
      expect(recordFile).toEqual(record);
      expect(cache).toMatchObject({
        schemaVersion: 1,
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

  it('matches metadata by SHA-256 after the generated file is renamed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-generated-metadata-rename-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const service = createGeneratedAssetMetadataService({
        now: () => '2026-05-24T00:00:00.000Z',
        createRecordId: () => 'record-1'
      });

      await service.recordGeneratedAsset(root, {
        projectRelativePath: 'generated/cover.png',
        modelRun: { request: { prompt: 'cover' }, output: { ok: true, raw: 'complete' } }
      });
      await rename(join(root, 'generated/cover.png'), join(root, 'generated/renamed-cover.png'));

      const lookup = await service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/renamed-cover.png' });

      expect(lookup.status).toBe('matched');
      if (lookup.status === 'matched') {
        expect(lookup.fingerprint.hash).toBe(sha256('image-bytes'));
        expect(lookup.records).toEqual([
	          {
	            schemaVersion: 1,
	            recordId: 'record-1',
	            projectRelativePath: 'generated/cover.png',
	            createdAt: '2026-05-24T00:00:00.000Z',
            fingerprint: { algorithm: 'sha256', hash: sha256('image-bytes') },
            modelRun: { request: { prompt: 'cover' }, output: { ok: true, raw: 'complete' } }
          }
        ]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns every matching metadata record newest first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-generated-metadata-duplicates-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('same-output'));
      let counter = 0;
      const service = createGeneratedAssetMetadataService({
        now: () => `2026-05-24T00:00:0${counter}.000Z`,
        createRecordId: () => `record-${counter += 1}`
      });

      await service.recordGeneratedAsset(root, {
        projectRelativePath: 'generated/cover.png',
        modelRun: { request: { prompt: 'first' }, output: { seed: 1 } }
      });
      await service.recordGeneratedAsset(root, {
        projectRelativePath: 'generated/cover.png',
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
    const root = await mkdtemp(join(tmpdir(), 'axis-generated-metadata-missing-record-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const service = createGeneratedAssetMetadataService({
        now: () => '2026-05-24T00:00:00.000Z',
        createRecordId: () => 'record-1'
      });

      await service.recordGeneratedAsset(root, {
        projectRelativePath: 'generated/cover.png',
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
            metadataPath: '.axis/assets/generated/record-1.json'
          }
        ]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats a missing metadata index and fingerprint cache as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-generated-metadata-empty-index-'));
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
        schemaVersion: 1,
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
    const root = await mkdtemp(join(tmpdir(), 'axis-generated-metadata-corrupt-cache-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await mkdir(join(root, '.axis/cache'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      await writeFile(join(root, '.axis/cache/file-fingerprints.json'), '{not-json', 'utf8');
      const service = createGeneratedAssetMetadataService();

      await expect(service.lookupGeneratedAssetMetadata(root, { projectRelativePath: 'generated/cover.png' }))
        .rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid fingerprint cache entries instead of dropping them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-generated-metadata-invalid-cache-entry-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await mkdir(join(root, '.axis/cache'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const fileStat = await stat(join(root, 'generated/cover.png'));
      await writeFile(join(root, '.axis/cache/file-fingerprints.json'), JSON.stringify({
        schemaVersion: 1,
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
    const root = await mkdtemp(join(tmpdir(), 'axis-generated-metadata-corrupt-index-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await mkdir(join(root, '.axis/assets'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      await writeFile(join(root, '.axis/assets/generated-assets-index.json'), '{not-json', 'utf8');
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
    const root = await mkdtemp(join(tmpdir(), 'axis-generated-metadata-invalid-path-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await mkdir(join(root, '.axis/assets'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
      const fingerprint = { algorithm: 'sha256' as const, hash: sha256('image-bytes') };
	      await writeFile(join(root, 'generated/not-metadata.json'), JSON.stringify({
	        schemaVersion: 1,
	        recordId: 'record-1',
	        projectRelativePath: 'generated/cover.png',
	        createdAt: '2026-05-24T00:00:00.000Z',
        fingerprint,
        modelRun: { request: { prompt: 'outside' }, output: { ok: true } }
      }, null, 2), 'utf8');
      await writeFile(join(root, '.axis/assets/generated-assets-index.json'), JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            recordId: 'record-1',
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

  it('skips a matching index entry when the record fingerprint does not match the entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-generated-metadata-record-fingerprint-mismatch-'));
    try {
      await mkdir(join(root, 'generated'), { recursive: true });
      await mkdir(join(root, '.axis/assets/generated'), { recursive: true });
      await writeFile(join(root, 'generated/cover.png'), Buffer.from('image-bytes'));
	      await writeFile(join(root, '.axis/assets/generated/record-1.json'), JSON.stringify({
	        schemaVersion: 1,
	        recordId: 'record-1',
	        projectRelativePath: 'generated/cover.png',
	        createdAt: '2026-05-24T00:00:00.000Z',
        fingerprint: { algorithm: 'sha256', hash: sha256('different-image-bytes') },
        modelRun: { request: { prompt: 'cover' }, output: { ok: true } }
      }, null, 2), 'utf8');
      await writeFile(join(root, '.axis/assets/generated-assets-index.json'), JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            recordId: 'record-1',
            createdAt: '2026-05-24T00:00:00.000Z',
            fingerprint: { algorithm: 'sha256', hash: sha256('image-bytes') },
            metadataPath: '.axis/assets/generated/record-1.json'
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
            metadataPath: '.axis/assets/generated/record-1.json'
          }
        ]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats missing and unreadable selected files as unavailable lookup results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-generated-metadata-missing-file-'));
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
