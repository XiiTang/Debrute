import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedFileWatchEvent } from '@axis/project-core';
import { AxisAppServer } from '../apps/app-server/src/server/AxisAppServer';
import { shouldIgnoreInternalProjectFileEvent } from '../apps/app-server/src/project-session/projectWatchEvents';

describe('App Server project watch events', () => {
  it('does not suppress unrelated external events during an internal write window', async () => {
    const event: NormalizedFileWatchEvent = {
      type: 'changed',
      absolutePath: '/project/notes.md',
      projectRelativePath: 'notes.md',
      observedAt: 100,
      affects: ['content']
    };

    await expect(shouldIgnoreInternalProjectFileEvent({
      event,
      internalProjectFileWrites: new Map()
    })).resolves.toBe(false);
  });

  it('serializes watched refreshes with manual Canvas layout updates', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-watch-layout-race-'));
    const watcherLayoutStarted = deferred<void>();
    const releaseWatcherLayout = deferred<void>();
    let blockLayoutRead = false;
    const server = new AxisAppServer({
      canvasNodeLayoutSizeReader: async (input) => {
        if (input.nodeKind === 'directory') {
          return { width: 240, height: 96 };
        }
        if (input.projectRelativePath === 'image-production/generated/a.png' && blockLayoutRead) {
          watcherLayoutStarted.resolve();
          await releaseWatcherLayout.promise;
        }
        return input.projectRelativePath.endsWith('/b.png')
          ? { width: 200, height: 50 }
          : { width: 100, height: 100 };
      }
    });

    try {
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/generated/b.png'), 'fake', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "generated/*.png"',
        ''
      ]);
      await server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });
      await server.refreshProject();

      const changedFilePath = join(projectRoot, 'image-production/generated/a.png');
      const observedAt = Date.now() + 1000;
      await writeFile(changedFilePath, 'fake', 'utf8');
      await utimes(changedFilePath, new Date(observedAt), new Date(observedAt));
      blockLayoutRead = true;
      const watchedRefresh = callWatchedFileEvent(server, {
        type: 'changed',
        absolutePath: changedFilePath,
        projectRelativePath: 'image-production/generated/a.png',
        observedAt,
        affects: ['content']
      });
      await watcherLayoutStarted.promise;
      const manualLayoutUpdate = server.updateCanvasNodeLayouts({
        canvasId: 'production-map',
        nodeLayouts: [{ projectRelativePath: 'image-production/generated/b.png', x: 999, y: 888, width: 777, height: 666 }]
      });
      releaseWatcherLayout.resolve();
      await watchedRefresh;
      await manualLayoutUpdate;

      const snapshot = await server.refreshProject();
      expect(snapshot.canvases[0]?.nodeElements.find((node) => node.projectRelativePath === 'image-production/generated/b.png')).toMatchObject({
        x: 999,
        y: 888,
        width: 777,
        height: 666,
        layoutMode: 'manual'
      });
    } finally {
      releaseWatcherLayout.resolve();
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function callWatchedFileEvent(server: AxisAppServer, event: NormalizedFileWatchEvent): Promise<void> {
  await (server as unknown as {
    handleWatchedFileEvent(event: NormalizedFileWatchEvent): Promise<void>;
  }).handleWatchedFileEvent(event);
}

async function writeFlowmapDraft(projectRoot: string, flowmapId: string, lines: string[]): Promise<void> {
  await mkdir(join(projectRoot, '.axis/flowmaps'), { recursive: true });
  await writeFile(join(projectRoot, `.axis/flowmaps/${flowmapId}.draft.yaml`), lines.join('\n'), 'utf8');
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => {
      resolve = next;
    }),
    resolve
  };
}
