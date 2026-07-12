import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectSessionSnapshot } from '@debrute/app-protocol';
import {
  consumeInternalProjectFileWatchEvent,
  createInternalProjectFileWriteReceipt,
  projectWatchRefreshFailedSnapshot
} from './projectWatchEvents.js';

describe('internal project file write receipts', () => {
  it('consumes a matching internal write exactly once without a timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-internal-write-receipt-'));
    try {
      const absolutePath = join(root, 'notes.md');
      await writeFile(absolutePath, 'saved', 'utf8');
      const receipts = new Map([
        [absolutePath, createInternalProjectFileWriteReceipt('saved')]
      ]);
      const event = {
        type: 'changed' as const,
        absolutePath,
        projectRelativePath: 'notes.md',
        affects: ['content' as const]
      };

      await expect(consumeInternalProjectFileWatchEvent({ event, receipts })).resolves.toBe(true);
      expect(receipts.size).toBe(0);
      await expect(consumeInternalProjectFileWatchEvent({ event, receipts })).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('drops a stale write receipt when the current file belongs to an external writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-external-write-receipt-'));
    try {
      const absolutePath = join(root, 'notes.md');
      await writeFile(absolutePath, 'external', 'utf8');
      const receipts = new Map([
        [absolutePath, createInternalProjectFileWriteReceipt('saved')]
      ]);

      await expect(consumeInternalProjectFileWatchEvent({
        event: {
          type: 'changed',
          absolutePath,
          projectRelativePath: 'notes.md',
          affects: ['content']
        },
        receipts
      })).resolves.toBe(false);
      expect(receipts.size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('consumes an internal delete only when the target is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-delete-receipt-'));
    try {
      const absolutePath = join(root, 'nested/deleted.md');
      await mkdir(join(root, 'nested'), { recursive: true });
      const receipts = new Map([
        [absolutePath, createInternalProjectFileWriteReceipt()]
      ]);

      await expect(consumeInternalProjectFileWatchEvent({
        event: {
          type: 'changed',
          absolutePath,
          projectRelativePath: 'nested/deleted.md',
          affects: ['content']
        },
        receipts
      })).resolves.toBe(true);
      expect(receipts.size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('projectWatchRefreshFailedSnapshot', () => {
  it('replaces the same path diagnostic and derives accurate counts', () => {
    const current: ProjectSessionSnapshot = {
      projectRoot: '/project',
      metadata: {
        project: {
          id: 'project-1',
          name: 'Project',
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z'
        }
      },
      files: [],
      canvases: [],
      projections: [],
      diagnostics: [{
        id: 'existing-warning',
        source: 'project',
        severity: 'warning',
        code: 'existing-warning',
        message: 'Existing warning'
      }],
      canvasRegistry: { status: 'ready', canvasOrder: [] },
      health: {
        projectName: 'Project',
        canvasCount: 0,
        diagnosticCounts: { errors: 0, warnings: 1, infos: 0 },
        runtimeDataLocation: '/runtime',
        checkedAt: '2026-07-12T00:00:00.000Z'
      }
    };
    const event = {
      type: 'changed' as const,
      absolutePath: '/project/.debrute/project.json',
      projectRelativePath: '.debrute/project.json',
      affects: ['project-metadata' as const]
    };

    const first = projectWatchRefreshFailedSnapshot({
      current,
      event,
      errorMessage: 'First failure',
      checkedAt: '2026-07-12T00:01:00.000Z'
    });
    const second = projectWatchRefreshFailedSnapshot({
      current: first,
      event,
      errorMessage: 'Second failure',
      checkedAt: '2026-07-12T00:02:00.000Z'
    });

    expect(second.diagnostics).toEqual([
      expect.objectContaining({
        id: 'project.watch.refresh_failed:.debrute/project.json',
        message: 'Second failure'
      }),
      current.diagnostics[0]
    ]);
    expect(second.health.diagnosticCounts).toEqual({ errors: 1, warnings: 1, infos: 0 });
  });
});
