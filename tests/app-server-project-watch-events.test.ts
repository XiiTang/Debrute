import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedFileWatchEvent } from '@debrute/project-core';
import { DebruteAppServer } from '../apps/app-server/src/server/DebruteAppServer';
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

  it('syncs Canvas Map file changes through watched refreshes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-watch-canvas-map-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: async (input) => {
        if (input.nodeKind === 'directory') {
          return { width: 240, height: 96 };
        }
        return { width: 100, height: 100 };
      }
    });

    try {
      await mkdir(join(projectRoot, 'outputs'), { recursive: true });
      await writeFile(join(projectRoot, 'outputs/a.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'outputs/b.png'), 'fake', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
      await writeCanvasMap(projectRoot, 'canvas-1', [
        'paths:',
        '  - outputs/a.png',
        ''
      ]);
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });

      const mapPath = join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml');
      await writeFile(mapPath, 'paths:\n  - outputs/b.png\n', 'utf8');
      await callWatchedFileEvent(server, {
        type: 'changed',
        absolutePath: mapPath,
        projectRelativePath: '.debrute/canvas-maps/canvas-1.yaml',
        observedAt: Date.now() + 1000,
        affects: ['canvas-map']
      });

      const snapshot = server.getSnapshot();
      expect(snapshot.files.map((file) => file.projectRelativePath)).toContain('.debrute/canvas-maps/canvas-1.yaml');
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toContain('outputs/b.png');
      expect(snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual(['outputs', 'outputs/b.png']);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('syncs Canvas Map folder rules when a matching file appears through a watched event', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-watch-canvas-map-content-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: async (input) => {
        if (input.nodeKind === 'directory') {
          return { width: 240, height: 96 };
        }
        return { width: 100, height: 100 };
      }
    });

    try {
      await mkdir(join(projectRoot, 'outputs'), { recursive: true });
      await writeFile(join(projectRoot, 'outputs/a.png'), 'fake', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
      await writeCanvasMap(projectRoot, 'canvas-1', [
        'paths:',
        '  - outputs/',
        ''
      ]);
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });

      const nextFilePath = join(projectRoot, 'outputs/b.png');
      await writeFile(nextFilePath, 'fake', 'utf8');
      await callWatchedFileEvent(server, {
        type: 'created',
        absolutePath: nextFilePath,
        projectRelativePath: 'outputs/b.png',
        observedAt: Date.now() + 1000,
        affects: ['content']
      });

      const snapshot = server.getSnapshot();
      expect(snapshot.files.map((file) => file.projectRelativePath)).toContain('outputs/b.png');
      expect(snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual([
        'outputs',
        'outputs/a.png',
        'outputs/b.png'
      ]);
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toContain('outputs/b.png');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps previous Canvas JSON when watched Canvas Map source is invalid', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-watch-invalid-canvas-map-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, 'notes'), { recursive: true });
      await writeFile(join(projectRoot, 'notes/a.md'), '# A\n', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
      await writeCanvasMap(projectRoot, 'canvas-1', [
        'paths:',
        '  - notes/a.md',
        ''
      ]);
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      const canvasBefore = await readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8');
      const mapPath = join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml');
      await writeFile(mapPath, 'paths:\n  - [broken\n', 'utf8');

      await callWatchedFileEvent(server, {
        type: 'changed',
        absolutePath: mapPath,
        projectRelativePath: '.debrute/canvas-maps/canvas-1.yaml',
        observedAt: Date.now() + 1000,
        affects: ['canvas-map']
      });

      const snapshot = server.getSnapshot();
      expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'project',
          severity: 'error',
          code: 'document_invalid_source',
          filePath: mapPath,
          entityId: 'canvas-1'
        })
      ]));
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toBe(canvasBefore);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('emits one project revision event for one external watched file change', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-watch-single-revision-'));
    const server = new DebruteAppServer();
    const events: string[] = [];

    try {
      await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
      server.onEvent((event) => events.push(event.type));
      await writeFile(join(projectRoot, 'brief.md'), '# Updated', 'utf8');
      await callWatchedFileEvent(server, {
        type: 'changed',
        absolutePath: join(projectRoot, 'brief.md'),
        projectRelativePath: 'brief.md',
        observedAt: Date.now() + 1000,
        affects: ['content']
      });

      expect(events).toEqual(['project.fileChanged']);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function callWatchedFileEvent(server: DebruteAppServer, event: NormalizedFileWatchEvent): Promise<void> {
  await (server as unknown as {
    handleWatchedFileEvent(event: NormalizedFileWatchEvent): Promise<void>;
  }).handleWatchedFileEvent(event);
}

async function writeCanvasMap(projectRoot: string, canvasId: string, lines: string[]): Promise<void> {
  await mkdir(join(projectRoot, '.debrute/canvas-maps'), { recursive: true });
  await writeFile(join(projectRoot, `.debrute/canvas-maps/${canvasId}.yaml`), lines.join('\n'), 'utf8');
}
