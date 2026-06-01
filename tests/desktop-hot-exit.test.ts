import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createHotExitStore,
  type DesktopHotExitSnapshot
} from '../apps/desktop/src/electron/hot-exit/hotExitStore';

describe('desktop Hot Exit store', () => {
  it('writes, reads, and clears the snapshot file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axis-hot-exit-'));
    try {
      const store = createHotExitStore(dir);
      const snapshot: DesktopHotExitSnapshot = {
        schemaVersion: 1,
        createdAt: '2026-05-17T00:00:00.000Z',
        projectRoot: '/project',
        textFileBuffers: [],
        textEditorWindows: []
      };

      await store.writeHotExitSnapshot(snapshot);
      expect(await store.readHotExitSnapshot()).toEqual(snapshot);

      await store.clearHotExitSnapshot();
      expect(await store.readHotExitSnapshot()).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no snapshot file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axis-hot-exit-missing-'));
    try {
      await expect(createHotExitStore(dir).readHotExitSnapshot()).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid current snapshot files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axis-hot-exit-invalid-'));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'hot-exit.json'), JSON.stringify({
        schemaVersion: 1,
        createdAt: '2026-05-17T00:00:00.000Z',
        textFileBuffers: []
      }), 'utf8');

      await expect(createHotExitStore(dir).readHotExitSnapshot()).rejects.toThrow('Invalid AXIS Hot Exit snapshot.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects current snapshot files with invalid nested fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axis-hot-exit-invalid-nested-'));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'hot-exit.json'), JSON.stringify({
        schemaVersion: 1,
        createdAt: '2026-05-17T00:00:00.000Z',
        projectRoot: '/project',
        activeCanvasId: 'production-map',
        explorerSelection: 'notes/brief.md',
        textFileBuffers: [{
          projectRelativePath: 7,
          content: 8,
          language: 9,
          wordWrap: 'yes'
        }],
        textEditorWindows: [{
          projectRelativePath: {},
          open: 'yes',
          x: 'x',
          y: 0,
          width: 0,
          height: 0
        }]
      }), 'utf8');

      await expect(createHotExitStore(dir).readHotExitSnapshot()).rejects.toThrow('Invalid AXIS Hot Exit snapshot.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects current snapshot files with invalid selection fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axis-hot-exit-invalid-selection-'));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'hot-exit.json'), JSON.stringify({
        schemaVersion: 1,
        createdAt: '2026-05-17T00:00:00.000Z',
        selection: { kind: 'multi' },
        textFileBuffers: [],
        textEditorWindows: []
      }), 'utf8');

      await expect(createHotExitStore(dir).readHotExitSnapshot()).rejects.toThrow('Invalid AXIS Hot Exit snapshot.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
