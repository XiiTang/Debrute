import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DebruteAppServer, DebruteGlobalRuntimeServer, GlobalConfigStore } from '@debrute/app-server';
import type { AppServerEvent } from '@debrute/app-protocol';
import { CANVAS_DOCUMENT_SCHEMA_VERSION } from '@debrute/canvas-core';

describe('app-server', () => {
  it('opens a project with current Canvas snapshot and health fields', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-'));
    const server = new DebruteAppServer();
    try {
      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      expect(snapshot.canvases).toHaveLength(1);
      expect(snapshot.health.canvasCount).toBe(1);
      expect(snapshot.canvases[0]).toMatchObject({
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
        id: 'canvas-1',
        nodeElements: []
      });
      expect(snapshot.canvases[0]).not.toHaveProperty('title');
      expect(snapshot.projections[0]).toMatchObject({
        canvasId: snapshot.canvases[0]!.id,
        nodes: []
      });
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.not.toContain('"title"');
      await expect(readFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), 'utf8')).resolves.toBe('paths: []\n');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('creates the default Canvas registry with the default Canvas', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-default-canvas-registry-'));
    const server = new DebruteAppServer();
    try {
      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      expect(snapshot.canvasRegistry).toEqual({
        status: 'ready',
        canvasOrder: ['canvas-1']
      });
      await expect(readFile(join(projectRoot, '.debrute/canvases/index.json'), 'utf8')).resolves.toBe([
        '{',
        '  "schemaVersion": 1,',
        '  "canvasOrder": [',
        '    "canvas-1"',
        '  ]',
        '}',
        ''
      ].join('\n'));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('orders loaded canvases through the Canvas registry and never reads index as a Canvas', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-registry-order-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
      await mkdir(join(projectRoot, '.debrute/canvas-maps'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: {
          id: 'registry-order',
          name: 'Registry Order',
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z'
        }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/a.json'), JSON.stringify(emptyCanvasDocument('a'), null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/b.json'), JSON.stringify(emptyCanvasDocument('b'), null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvas-maps/a.yaml'), 'paths: []\n', 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvas-maps/b.yaml'), 'paths: []\n', 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/index.json'), JSON.stringify({
        schemaVersion: 1,
        canvasOrder: ['b', 'a']
      }, null, 2), 'utf8');

      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      });

      expect(snapshot.canvasRegistry).toEqual({
        status: 'ready',
        canvasOrder: ['b', 'a']
      });
      expect(snapshot.canvases.map((canvas) => canvas.id)).toEqual(['b', 'a']);
      expect(snapshot.projections.map((projection) => projection.canvasId)).toEqual(['b', 'a']);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('creates, renames, reorders, and deletes canvases through the registry service', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-management-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });

      const created = await server.createCanvas();
      expect(created.activeCanvasId).toBe('canvas-2');
      expect(created.snapshot.canvases.map((canvas) => canvas.id)).toEqual(['canvas-1', 'canvas-2']);
      await expect(readFile(join(projectRoot, '.debrute/canvas-maps/canvas-2.yaml'), 'utf8')).resolves.toBe('paths: []\n');

      const renamed = await server.renameCanvas({ canvasId: 'canvas-2', nextCanvasId: 'storyboard' });
      expect(renamed.activeCanvasId).toBe('storyboard');
      expect(renamed.snapshot.canvases.map((canvas) => canvas.id)).toEqual(['canvas-1', 'storyboard']);
      await expect(readFile(join(projectRoot, '.debrute/canvas-maps/storyboard.yaml'), 'utf8')).resolves.toBe('paths: []\n');
      await expect(readFile(join(projectRoot, '.debrute/canvas-maps/canvas-2.yaml'), 'utf8')).rejects.toThrow();
      expect(await readJson(join(projectRoot, '.debrute/canvases/storyboard.json'))).toMatchObject({ id: 'storyboard' });

      const reordered = await server.reorderCanvases({ canvasOrder: ['storyboard', 'canvas-1'] });
      expect(reordered.snapshot.canvases.map((canvas) => canvas.id)).toEqual(['storyboard', 'canvas-1']);

      const deleted = await server.deleteCanvas({ canvasId: 'storyboard' });
      expect(deleted.activeCanvasId).toBe('canvas-1');
      expect(deleted.snapshot.canvases.map((canvas) => canvas.id)).toEqual(['canvas-1']);
      await expect(readFile(join(projectRoot, '.debrute/canvases/storyboard.json'), 'utf8')).rejects.toThrow();
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects canvas management conflicts and invalid operations without rewriting files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-conflicts-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await server.createCanvas();
      await writeFile(join(projectRoot, '.debrute/canvases/index.json'), JSON.stringify({
        schemaVersion: 1,
        canvasOrder: ['canvas-2', 'canvas-1']
      }, null, 2), 'utf8');

      await expect(server.reorderCanvases({ canvasOrder: ['canvas-1', 'canvas-2'] })).rejects.toMatchObject({
        code: 'canvas_registry_conflict'
      });

      await server.refreshProject();
      await writeFile(join(projectRoot, '.debrute/canvas-maps/canvas-2.yaml'), 'paths:\n  - changed.md\n', 'utf8');
      await expect(server.renameCanvas({ canvasId: 'canvas-2', nextCanvasId: 'storyboard' })).rejects.toMatchObject({
        code: 'canvas_map_conflict'
      });

      await server.refreshProject();
      await expect(server.deleteCanvas({ canvasId: 'canvas-1' })).resolves.toBeDefined();
      await expect(server.deleteCanvas({ canvasId: 'canvas-2' })).rejects.toMatchObject({
        code: 'canvas_registry_invalid'
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('repairs an invalid Canvas registry only through the explicit repair operation', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-repair-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
      await mkdir(join(projectRoot, '.debrute/canvas-maps'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: {
          id: 'repair',
          name: 'Repair',
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z'
        }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/b.json'), JSON.stringify(emptyCanvasDocument('b'), null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/a.json'), JSON.stringify(emptyCanvasDocument('a'), null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvas-maps/b.yaml'), 'paths: []\n', 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvas-maps/a.yaml'), 'paths: []\n', 'utf8');

      const opened = await server.openProject(projectRoot, { initializeIfMissing: false, createDefaultCanvas: false });
      expect(opened.canvasRegistry).toMatchObject({ status: 'invalid', code: 'canvas_registry_missing' });
      expect(opened.canvases).toEqual([]);

      const repaired = await server.repairCanvasIndex();
      expect(repaired.snapshot.canvasRegistry).toEqual({ status: 'ready', canvasOrder: ['a', 'b'] });
      expect(repaired.activeCanvasId).toBe('a');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports invalid canvas state without deleting or rewriting it', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-invalid-canvas-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: { name: 'Broken Canvas Project' }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), JSON.stringify({
        schemaVersion: 3,
        id: 'canvas-1',
        nodeElements: [],
        annotations: [],
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');

      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      });

      expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'project',
          severity: 'error',
          code: 'document_invalid_pushed',
          message: expect.stringContaining('Invalid canvas document schema'),
          filePath: join(projectRoot, '.debrute/canvases/canvas-1.json'),
          entityId: 'canvas-1'
        })
      ]));
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toContain('"schemaVersion": 3');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not create a default canvas over an invalid pushed document', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-invalid-canvas-default-open-'));
    const server = new DebruteAppServer();
    const invalidCanvas = '{"schemaVersion":3,"id":"canvas-1","nodeElements":[],"annotations":[],"preferences":{"showDiagnostics":true}}\n';
    try {
      await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: { name: 'Broken Canvas Project' }
      }, null, 2), 'utf8');
      const canvasPath = join(projectRoot, '.debrute/canvases/canvas-1.json');
      await writeFile(canvasPath, invalidCanvas, 'utf8');

      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: true
      });

      expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'project',
          severity: 'error',
          code: 'document_invalid_pushed',
          filePath: canvasPath,
          entityId: 'canvas-1'
        })
      ]));
      await expect(readFile(canvasPath, 'utf8')).resolves.toBe(invalidCanvas);
      await expect(readFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), 'utf8')).rejects.toBeDefined();
      await expect(readFile(join(projectRoot, '.debrute/canvases/index.json'), 'utf8')).rejects.toBeDefined();
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports Canvas documents with filesystem-unsafe ids', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-unsafe-canvas-id-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: { name: 'Unsafe Canvas Project' }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), JSON.stringify({
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
        id: '../../../escape',
        nodeElements: [],
        annotations: [],
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');

      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      });

      expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'project',
          severity: 'error',
          code: 'document_invalid_pushed',
          message: expect.stringContaining('Invalid canvas document id'),
          filePath: join(projectRoot, '.debrute/canvases/canvas-1.json'),
          entityId: 'canvas-1'
        })
      ]));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reads missing Canvas feedback as an empty current-state document', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-feedback-empty-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      const feedback = await server.readCanvasFeedback();

      expect(feedback).toMatchObject({
        schemaVersion: 1,
        entries: {}
      });
      expect(feedback.updatedAt).toEqual(expect.any(String));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('checks non-empty project files through the app-server boundary', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-project-file-exists-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      await mkdir(join(projectRoot, 'generated'), { recursive: true });
      await writeFile(join(projectRoot, 'generated/full.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'generated/empty.png'), '', 'utf8');

      await expect(server.projectFileExistsWithContent({ projectRelativePath: 'generated/full.png' })).resolves.toBe(true);
      await expect(server.projectFileExistsWithContent({ projectRelativePath: 'generated/empty.png' })).resolves.toBe(false);
      await expect(server.projectFileExistsWithContent({ projectRelativePath: 'generated/missing.png' })).resolves.toBe(false);
      await expect(server.projectFileExistsWithContent({ projectRelativePath: '../outside.png' })).rejects.toThrow('Project path must not contain "." or ".." segments');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('mutates project files and returns refreshed snapshots', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-file-ops-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      const directory = await server.createProjectDirectory({ parentProjectRelativePath: '', name: 'briefs' });
      expect(directory.projectRelativePath).toBe('briefs');
      expect(directory.kind).toBe('directory');
      expect(directory.snapshot.files.map((file) => file.projectRelativePath)).toContain('briefs');

      const file = await server.createProjectFile({ parentProjectRelativePath: 'briefs', name: 'concept.md' });
      expect(file.projectRelativePath).toBe('briefs/concept.md');
      expect(file.kind).toBe('file');
      expect(file.snapshot.files.map((entry) => entry.projectRelativePath)).toContain('briefs/concept.md');

      const renamed = await server.renameProjectPath({ projectRelativePath: 'briefs/concept.md', name: 'outline.md' });
      expect(renamed.projectRelativePath).toBe('briefs/outline.md');
      expect(renamed.snapshot.files.map((entry) => entry.projectRelativePath)).toContain('briefs/outline.md');

      const copied = await server.copyProjectPaths({
        entries: [{ projectRelativePath: 'briefs/outline.md', kind: 'file' }],
        targetDirectoryProjectRelativePath: 'briefs'
      });
      expect(copied.results).toEqual([
        { sourceProjectRelativePath: 'briefs/outline.md', projectRelativePath: 'briefs/outline copy.md', kind: 'file', status: 'ok' }
      ]);
      expect(copied.snapshot.files.map((entry) => entry.projectRelativePath)).toContain('briefs/outline copy.md');

      const moved = await server.moveProjectPaths({
        entries: [{ projectRelativePath: 'briefs/outline copy.md', kind: 'file' }],
        targetDirectoryProjectRelativePath: ''
      });
      expect(moved.results).toEqual([
        { sourceProjectRelativePath: 'briefs/outline copy.md', projectRelativePath: 'outline copy.md', kind: 'file', status: 'ok' }
      ]);
      expect(moved.snapshot.files.map((entry) => entry.projectRelativePath)).toContain('outline copy.md');

      const deleted = await server.deleteProjectPathsPermanently({
        entries: [{ projectRelativePath: 'outline copy.md', kind: 'file' }]
      });
      expect(deleted.results).toEqual([
        { sourceProjectRelativePath: 'outline copy.md', projectRelativePath: 'outline copy.md', kind: 'file', status: 'ok' }
      ]);
      expect(deleted.snapshot.files.map((entry) => entry.projectRelativePath)).not.toContain('outline copy.md');
      await expect(stat(join(projectRoot, 'outline copy.md'))).rejects.toThrow();
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not expose a persisted Canvas settings config path', async () => {
    const debruteHome = await mkdtemp(join(tmpdir(), 'debrute-app-server-no-canvas-settings-home-'));
    const globalConfigStore = new GlobalConfigStore({ debruteHome });
    const globalRuntime = new DebruteGlobalRuntimeServer({
      globalConfigStore
    });
    try {
      expect(Object.keys(globalConfigStore.paths()).sort()).toEqual([
        'imageModelsFile',
        'llmProvidersFile',
        'root',
        'secretsFile',
        'videoModelsFile'
      ]);
    } finally {
      globalRuntime.close();
      await rm(debruteHome, { recursive: true, force: true });
    }
  });

  it('writes, preserves, and clears Canvas feedback entries', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-feedback-write-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      const first = await server.updateCanvasFeedbackEntry({
        projectRelativePath: 'flow/a.png',
        marks: ['cross', 'like'],
        note: '  Keep A.  '
      });
      const second = await server.updateCanvasFeedbackEntry({
        projectRelativePath: 'flow/b.png',
        marks: ['needs_revision'],
        note: ''
      });
      const cleared = await server.updateCanvasFeedbackEntry({
        projectRelativePath: 'flow/a.png',
        marks: [],
        note: '   '
      });

      expect(first.entries['flow/a.png']).toMatchObject({
        projectRelativePath: 'flow/a.png',
        marks: ['like', 'cross'],
        note: 'Keep A.'
      });
      expect(second.entries['flow/a.png']).toBeDefined();
      expect(second.entries['flow/b.png']).toMatchObject({
        marks: ['needs_revision'],
        note: ''
      });
      expect(cleared.entries['flow/a.png']).toBeUndefined();
      expect(cleared.entries['flow/b.png']).toMatchObject({
        projectRelativePath: 'flow/b.png',
        marks: ['needs_revision'],
        note: ''
      });
      expect(await readJson(join(projectRoot, '.debrute/reviews/canvas-feedback.json'))).toEqual(cleared);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('emits Canvas feedback changes as shared project state events', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-feedback-event-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      const events: AppServerEvent[] = [];
      const unsubscribe = server.onEvent((event) => events.push(event));

      await server.updateCanvasFeedbackEntry({
        projectRelativePath: 'brief.md',
        marks: ['like'],
        note: 'Use this direction'
      });
      unsubscribe();

      expect(events.find((event) => event.type === 'canvas.feedback.changed')).toMatchObject({
        type: 'canvas.feedback.changed',
        feedback: {
          entries: {
            'brief.md': {
              projectRelativePath: 'brief.md',
              marks: ['like'],
              note: 'Use this direction'
            }
          }
        }
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns Canvas mutation projection data for revisioned HTTP envelopes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-canvas-mutation-result-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      const result = await server.updateCanvasNodeLayouts({
        canvasId: 'canvas-1',
        nodeLayouts: []
      });

      expect(result).toMatchObject({
        canvas: { id: 'canvas-1' },
        projection: { canvasId: 'canvas-1' }
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('preserves all Canvas feedback entries from overlapping writes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-feedback-concurrent-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      await Promise.all(Array.from({ length: 8 }, async (_item, index) => {
        await server.updateCanvasFeedbackEntry({
          projectRelativePath: `flow/${index}.png`,
          marks: ['like'],
          note: `Option ${index}`
        });
      }));

      const feedback = await server.readCanvasFeedback();

      expect(Object.keys(feedback.entries).sort()).toEqual([
        'flow/0.png',
        'flow/1.png',
        'flow/2.png',
        'flow/3.png',
        'flow/4.png',
        'flow/5.png',
        'flow/6.png',
        'flow/7.png'
      ]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not overwrite invalid Canvas feedback files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-feedback-invalid-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      const feedbackPath = join(projectRoot, '.debrute/reviews/canvas-feedback.json');
      await mkdir(join(projectRoot, '.debrute/reviews'), { recursive: true });
      await writeFile(feedbackPath, '{"schemaVersion":1,"entries":', 'utf8');

      await expect(server.updateCanvasFeedbackEntry({
        projectRelativePath: 'flow/a.png',
        marks: ['like'],
        note: ''
      })).rejects.toThrow();

      expect(await readFile(feedbackPath, 'utf8')).toBe('{"schemaVersion":1,"entries":');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid Canvas feedback storage paths', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-feedback-invalid-path-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      await writeFile(join(projectRoot, '.debrute/reviews'), 'not a directory', 'utf8');

      await expect(server.readCanvasFeedback()).rejects.toThrow();
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports Canvas node elements with unsupported fields', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-unsupported-canvas-field-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: { name: 'Unsupported Canvas Field Project' }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), JSON.stringify({
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
        id: 'canvas-1',
        nodeElements: [{
          projectRelativePath: 'generated/a.png',
          nodeKind: 'file',
          mediaKind: 'image',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          z: 0,
          unsupportedField: true
        }],
        annotations: [],
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');

      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      });

      expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'project',
          severity: 'error',
          code: 'document_invalid_pushed',
          message: expect.stringContaining('Invalid canvas document schema'),
          filePath: join(projectRoot, '.debrute/canvases/canvas-1.json'),
          entityId: 'canvas-1'
        })
      ]));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('accepts manual Canvas node layout mode in current Canvas JSON', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-manual-layout-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
      await mkdir(join(projectRoot, '.debrute/canvas-maps'), { recursive: true });
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/generated/a.md'), 'fake', 'utf8');
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: { name: 'Manual Layout Project' }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), JSON.stringify({
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
        id: 'canvas-1',
        nodeElements: [{
          projectRelativePath: 'image-production/generated/a.md',
          nodeKind: 'file',
          mediaKind: 'text',
          x: 9,
          y: 8,
          width: 7,
          height: 6,
          z: 0,
          layoutMode: 'manual'
        }],
        annotations: [],
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), canvasMapSource(['image-production/generated/a.md']), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/index.json'), JSON.stringify({
        schemaVersion: 1,
        canvasOrder: ['canvas-1']
      }, null, 2), 'utf8');

      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      });

      expect(snapshot.canvases[0]?.nodeElements.find((node) => node.projectRelativePath === 'image-production/generated/a.md')).toMatchObject({ layoutMode: 'manual' });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports auto Canvas node layout mode in current Canvas JSON', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-auto-layout-mode-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: { name: 'Auto Layout Mode Project' }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), JSON.stringify({
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
        id: 'canvas-1',
        nodeElements: [{
          projectRelativePath: 'generated/a.png',
          nodeKind: 'file',
          mediaKind: 'image',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          z: 0,
          layoutMode: 'auto'
        }],
        annotations: [],
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');

      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      });

      expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'project',
          severity: 'error',
          code: 'document_invalid_pushed',
          message: expect.stringContaining('Invalid canvas document schema'),
          filePath: join(projectRoot, '.debrute/canvases/canvas-1.json'),
          entityId: 'canvas-1'
        })
      ]));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('creates the default Canvas based only on current Canvas JSON files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-default-canvas-json-only-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: {
          id: 'project-default-canvas-json-only',
          name: 'Default Canvas JSON Only',
          createdAt: '2026-05-25T10:30:00.000Z',
          updatedAt: '2026-05-25T10:30:00.000Z'
        }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/old.yaml'), 'not a Canvas JSON file\n', 'utf8');

      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: true
      });

      expect(snapshot.canvases.map((canvas) => canvas.id)).toEqual(['canvas-1']);
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toContain('"nodeElements": []');
      await expect(readFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), 'utf8')).resolves.toBe('paths: []\n');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns the current image model request failure payload for CLI callers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-image-model-error-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-model-error-project-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore });
    const server = new DebruteAppServer({
      globalConfigStore: configStore,
      imageModelFetch: async () => new Response(JSON.stringify({
        error: { message: 'quota exceeded' }
      }), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      })
    });
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await globalRuntime.imageModelSaveSetting('gpt-image-2', {
        requestModelIdOverride: null,
        apiKey: 'sk-image'
      });

      const result = await server.runImageModelRequestForCli({
        model: 'gpt-image-2',
        arguments: { prompt: 'cover image' },
        timeoutMs: 25
      });

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error.code).toBe('request_failed');
        expect(result.outputs).toEqual({
          content: 'Image request failed: model endpoint responded with HTTP 429.',
          model: 'gpt-image-2'
        });
      }
    } finally {
      globalRuntime.close();
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('saves LLM settings that make llm_request usable from persisted config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-llm-settings-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-llm-settings-project-'));
    const originalFetch = globalThis.fetch;
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore });
    const server = new DebruteAppServer({ globalConfigStore: configStore });
    try {
      globalThis.fetch = async (url, init) => {
        expect(url).toBe('https://api.openai.com/v1/chat/completions');
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer sk-llm-test',
          'content-type': 'application/json'
        });
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'configured llm result' } }]
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      };
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      const initial = await globalRuntime.llmGetSettings();
      expect(initial).toEqual({
        providers: [],
        availableModelKeys: [],
        defaultModelKey: null
      });

      await globalRuntime.llmSaveProviderSetting({
        id: 'openai-main',
        name: 'OpenAI Compatible',
        providerType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        modelIds: ['gpt-5.1'],
        apiKey: 'sk-llm-test'
      });
      const settings = await globalRuntime.llmSetDefaultModelKey('openai-main:gpt-5.1');

      expect(settings).toMatchObject({
        defaultModelKey: 'openai-main:gpt-5.1',
        availableModelKeys: ['openai-main:gpt-5.1'],
        providers: [
          expect.objectContaining({
            id: 'openai-main',
            providerType: 'openai_compat',
            modelIds: ['gpt-5.1'],
            apiKeySet: true,
            apiKeyPreview: 'sk****************************st'
          })
        ]
      });
      expect(settings.providers[0] as Record<string, unknown>).not.toHaveProperty('apiKey');
      expect(JSON.stringify(settings)).not.toContain('sk-llm-test');

      const result = await server.runLlmRequestForCli({ modelKey: 'default', prompt: 'Say hello.' });
      expect(result).toMatchObject({
        status: 'ok',
        outputs: {
          text: 'configured llm result',
          modelKey: 'openai-main:gpt-5.1'
        }
      });
    } finally {
      globalRuntime.close();
      server.close();
      globalThis.fetch = originalFetch;
      await rm(home, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('preserves, replaces, and clears provider API keys through settings saves', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-settings-secret-semantics-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore });
    try {
      await globalRuntime.llmSaveProviderSetting({
        id: 'openai-main',
        name: 'OpenAI Compatible',
        providerType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        modelIds: ['gpt-5.1'],
        apiKey: 'sk-llm-initial'
      });
      await globalRuntime.llmSaveProviderSetting({
        id: 'openai-main',
        name: 'OpenAI Compatible Updated',
        providerType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        modelIds: ['gpt-5.1']
      }, 'openai-main');
      await globalRuntime.imageModelSaveSetting('gpt-image-2', {
        requestModelIdOverride: 'gpt-image-2',
        apiKey: 'sk-image-initial'
      });
      await globalRuntime.imageModelSaveSetting('gpt-image-2', {
        requestModelIdOverride: null
      });
      await globalRuntime.videoModelSaveSetting('doubao-seedance-2-0-260128', {
        requestModelIdOverride: null,
        apiKey: 'sk-video-initial'
      });
      await globalRuntime.videoModelSaveSetting('doubao-seedance-2-0-260128', {
        requestModelIdOverride: 'doubao-seedance-2-0-260128'
      });

      let secrets = await configStore.readSecrets();
      expect(secrets.llmProviderApiKeys['openai-main']).toBe('sk-llm-initial');
      expect(secrets.imageModelApiKeys['gpt-image-2']).toBe('sk-image-initial');
      expect(secrets.videoModelApiKeys['doubao-seedance-2-0-260128']).toBe('sk-video-initial');

      await globalRuntime.llmSaveProviderSetting({
        id: 'openai-main',
        name: 'OpenAI Compatible Updated',
        providerType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        modelIds: ['gpt-5.1'],
        apiKey: 'sk-llm-replaced'
      }, 'openai-main');
      await globalRuntime.imageModelSaveSetting('gpt-image-2', {
        requestModelIdOverride: null,
        apiKey: 'sk-image-replaced'
      });
      await globalRuntime.videoModelSaveSetting('doubao-seedance-2-0-260128', {
        requestModelIdOverride: null,
        apiKey: 'sk-video-replaced'
      });

      secrets = await configStore.readSecrets();
      expect(secrets.llmProviderApiKeys['openai-main']).toBe('sk-llm-replaced');
      expect(secrets.imageModelApiKeys['gpt-image-2']).toBe('sk-image-replaced');
      expect(secrets.videoModelApiKeys['doubao-seedance-2-0-260128']).toBe('sk-video-replaced');

      const llmView = await globalRuntime.llmSaveProviderSetting({
        id: 'openai-main',
        name: 'OpenAI Compatible Updated',
        providerType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        modelIds: ['gpt-5.1'],
        apiKey: ''
      }, 'openai-main');
      const imageView = await globalRuntime.imageModelSaveSetting('gpt-image-2', {
        requestModelIdOverride: null,
        apiKey: ''
      });
      const videoView = await globalRuntime.videoModelSaveSetting('doubao-seedance-2-0-260128', {
        requestModelIdOverride: null,
        apiKey: ''
      });

      secrets = await configStore.readSecrets();
      expect(secrets.llmProviderApiKeys).not.toHaveProperty('openai-main');
      expect(secrets.imageModelApiKeys).not.toHaveProperty('gpt-image-2');
      expect(secrets.videoModelApiKeys).not.toHaveProperty('doubao-seedance-2-0-260128');
      expect(llmView.providers[0]).toMatchObject({ apiKeySet: false });
      expect(imageView.models.find((model) => model.debruteModelId === 'gpt-image-2')).toMatchObject({ apiKeySet: false });
      expect(videoView.models.find((model) => model.debruteModelId === 'doubao-seedance-2-0-260128')).toMatchObject({ apiKeySet: false });
      expect(JSON.stringify({ llmView, imageView, videoView })).not.toContain('sk-');
    } finally {
      globalRuntime.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('discovers OpenAI-compatible provider models from LLM settings input', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-llm-discovery-home-'));
    const originalFetch = globalThis.fetch;
    const globalRuntime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home })
    });
    try {
      globalThis.fetch = async (url, init) => {
        expect(url).toBe('https://api.example.test/v1/models');
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer sk-discovery-test'
        });
        return new Response(JSON.stringify({
          data: [
            { id: 'gpt-debrute-a' },
            { id: 'gpt-debrute-b' },
            { id: 'gpt-debrute-a' }
          ]
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      };

      const result = await globalRuntime.llmDiscoverProviderModels({
        id: 'openai-main',
        providerType: 'openai_compat',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-discovery-test'
      });

      expect(result).toEqual({
        endpoint: 'https://api.example.test/v1/models',
        models: ['gpt-debrute-a', 'gpt-debrute-b'],
        modelsCount: 2,
        supportsDiscovery: true
      });
    } finally {
      globalRuntime.close();
      globalThis.fetch = originalFetch;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not attach a stored LLM provider key when discovery targets a different base URL', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-llm-discovery-origin-binding-home-'));
    const originalFetch = globalThis.fetch;
    const globalRuntime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home })
    });
    const calls: Array<{ url: string; authorization?: string }> = [];
    try {
      globalThis.fetch = async (url, init) => {
        calls.push({
          url: String(url),
          authorization: (init?.headers as Record<string, string> | undefined)?.authorization
        });
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      };
      await globalRuntime.llmSaveProviderSetting({
        id: 'openai-main',
        name: 'OpenAI Compatible',
        providerType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        modelIds: ['gpt-5.1'],
        apiKey: 'sk-stored-discovery'
      });

      await globalRuntime.llmDiscoverProviderModels({
        id: 'openai-main',
        providerType: 'openai_compat',
        baseUrl: 'https://attacker.example/v1'
      });

      expect(calls).toEqual([{
        url: 'https://attacker.example/v1/models',
        authorization: undefined
      }]);
    } finally {
      globalRuntime.close();
      globalThis.fetch = originalFetch;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('uses a stored LLM provider key when discovery targets the stored provider base URL', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-llm-discovery-stored-key-home-'));
    const originalFetch = globalThis.fetch;
    const globalRuntime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home })
    });
    const calls: Array<{ url: string; authorization?: string }> = [];
    try {
      globalThis.fetch = async (url, init) => {
        calls.push({
          url: String(url),
          authorization: (init?.headers as Record<string, string> | undefined)?.authorization
        });
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      };
      await globalRuntime.llmSaveProviderSetting({
        id: 'openai-main',
        name: 'OpenAI Compatible',
        providerType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        modelIds: ['gpt-5.1'],
        apiKey: 'sk-stored-discovery'
      });

      await globalRuntime.llmDiscoverProviderModels({
        id: 'openai-main',
        providerType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1'
      });

      expect(calls).toEqual([{
        url: 'https://api.openai.com/v1/models',
        authorization: 'Bearer sk-stored-discovery'
      }]);
    } finally {
      globalRuntime.close();
      globalThis.fetch = originalFetch;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('saves media model request-model overrides and derives configured state from API keys', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-media-model-settings-home-'));
    const globalRuntime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home })
    });
    try {
      const imageSettings = await globalRuntime.imageModelSaveSetting('gpt-image-2', {
        requestModelIdOverride: 'custom-image-model',
        apiKey: 'sk-image'
      });
      const videoSettings = await globalRuntime.videoModelSaveSetting('doubao-seedance-2-0-260128', {
        requestModelIdOverride: 'custom-video-model',
        apiKey: 'sk-video'
      });

      const imageModel = imageSettings.models.find((model) => model.debruteModelId === 'gpt-image-2');
      const videoModel = videoSettings.models.find((model) => model.debruteModelId === 'doubao-seedance-2-0-260128');

      expect(imageModel).toEqual({
        debruteModelId: 'gpt-image-2',
        summary: expect.any(String),
        supportsEditing: expect.any(Boolean),
        supportsTextRendering: expect.any(Boolean),
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultRequestModelId: 'gpt-image-2',
        requestModelIdOverride: 'custom-image-model',
        apiKeySet: true,
        apiKeyPreview: 'sk****************************ge'
      });
      expect(videoModel).toEqual({
        debruteModelId: 'doubao-seedance-2-0-260128',
        summary: expect.any(String),
        supportsTextToVideo: expect.any(Boolean),
        supportsImageReferences: expect.any(Boolean),
        supportsVideoReferences: expect.any(Boolean),
        supportsAudioReferences: expect.any(Boolean),
        supportsGeneratedAudio: expect.any(Boolean),
        defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        defaultRequestModelId: 'doubao-seedance-2-0-260128',
        requestModelIdOverride: 'custom-video-model',
        apiKeySet: true,
        apiKeyPreview: 'sk****************************eo'
      });
      expect(imageModel as Record<string, unknown>).not.toHaveProperty('apiKey');
      expect(videoModel as Record<string, unknown>).not.toHaveProperty('apiKey');
    } finally {
      globalRuntime.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects malformed media model setting saves instead of clearing overrides', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-media-model-invalid-save-home-'));
    const globalRuntime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home })
    });
    try {
      await expect(globalRuntime.imageModelSaveSetting('gpt-image-2', {} as never)).rejects.toMatchObject({
        code: 'invalid_input'
      });
      await expect(globalRuntime.videoModelSaveSetting('doubao-seedance-2-0-260128', {
        requestModelIdOverride: '   '
      })).rejects.toMatchObject({
        code: 'invalid_input'
      });
    } finally {
      globalRuntime.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('stores API-key-only media settings only in secrets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-media-model-api-key-only-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore });
    try {
      const settings = await globalRuntime.imageModelSaveSetting('gpt-image-2', {
        requestModelIdOverride: null,
        apiKey: 'sk-image'
      });

      const imageModel = settings.models.find((model) => model.debruteModelId === 'gpt-image-2');
      expect(imageModel).toEqual({
        debruteModelId: 'gpt-image-2',
        summary: expect.any(String),
        supportsEditing: expect.any(Boolean),
        supportsTextRendering: expect.any(Boolean),
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultRequestModelId: 'gpt-image-2',
        requestModelIdOverride: null,
        apiKeySet: true,
        apiKeyPreview: 'sk****************************ge'
      });
      expect(imageModel as Record<string, unknown>).not.toHaveProperty('apiKey');
      await expect(configStore.readImageModels()).resolves.toEqual({ imageModels: [] });
      await expect(configStore.readSecrets()).resolves.toMatchObject({
        imageModelApiKeys: { 'gpt-image-2': 'sk-image' }
      });
    } finally {
      globalRuntime.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects malformed media model config records instead of filling missing fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-media-model-strict-config-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const paths = configStore.paths();
    try {
      await mkdir(paths.root, { recursive: true });
      await writeFile(paths.imageModelsFile, JSON.stringify({
        imageModels: [{ debruteModelId: 'gpt-image-2' }]
      }), 'utf8');

      await expect(configStore.readImageModels()).rejects.toThrow('Image model requestModelIdOverride must be a string or null.');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('writes secrets with private config directory and file permissions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-secret-permissions-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const configDir = join(home, 'config');
    const secretsFile = join(configDir, 'secrets.json');
    try {
      await configStore.saveSecrets({
        llmProviderApiKeys: { openai: 'sk-llm' },
        imageModelApiKeys: { 'gpt-image-2': 'sk-image' },
        videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' }
      });

      expect((await stat(configDir)).mode & 0o777).toBe(0o700);
      expect((await stat(secretsFile)).mode & 0o777).toBe(0o600);

      await chmod(secretsFile, 0o644);
      expect((await stat(secretsFile)).mode & 0o777).toBe(0o644);

      await configStore.saveSecrets({
        llmProviderApiKeys: { openai: 'sk-llm-next' },
        imageModelApiKeys: {},
        videoModelApiKeys: {}
      });

      expect((await stat(configDir)).mode & 0o777).toBe(0o700);
      expect((await stat(secretsFile)).mode & 0o777).toBe(0o600);
      await expect(readFile(secretsFile, 'utf8')).resolves.toContain('sk-llm-next');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reads, writes, and projects Canvas Map nodes on Canvas', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-assets-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      await mkdir(join(projectRoot, 'notes'), { recursive: true });
      await writeFile(join(projectRoot, 'notes/brief.md'), '# Brief\n', 'utf8');

      const textFile = await server.readProjectTextFile('notes/brief.md');
      const written = await server.writeProjectTextFile('notes/output.md', 'done\n');
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['notes/*.md']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      const snapshot = await server.refreshProject();

      expect(textFile.content).toBe('# Brief\n');
      expect(written.projectRelativePath).toBe('notes/output.md');
      await expect(readFile(join(projectRoot, 'notes/output.md'), 'utf8')).resolves.toBe('done\n');
      expect(snapshot.canvases[0]?.nodeElements.map((node) => [node.projectRelativePath, node.nodeKind, node.mediaKind])).toEqual([
        ['', 'directory', undefined],
        ['notes', 'directory', undefined],
        ['notes/brief.md', 'file', 'text'],
        ['notes/output.md', 'file', 'text']
      ]);
      expect(snapshot.projections[0]?.nodes.find((node) => node.projectRelativePath === 'notes/brief.md')).toMatchObject({
        availability: { state: 'available', mimeType: 'text/markdown' }
      });
      expect(snapshot.projections[0]?.edges.map((edge) => [edge.sourceProjectRelativePath, edge.targetProjectRelativePath])).toEqual([
        ['', 'notes'],
        ['notes', 'notes/brief.md'],
        ['notes', 'notes/output.md']
      ]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('materializes dynamic generic node widths during Canvas Map synchronization', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-generic-widths-'));
    const server = new DebruteAppServer();
    const directoryPath = 'references/long-folder-name-for-rendering-output-archive';
    const unknownFilePath = `${directoryPath}/unsupported-reference-render-settings.archive`;
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      await mkdir(join(projectRoot, directoryPath), { recursive: true });
      await writeFile(join(projectRoot, unknownFilePath), 'settings', 'utf8');

      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([`${directoryPath}/`]));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      const snapshot = await server.refreshProject();
      const nodes = snapshot.canvases[0]?.nodeElements ?? [];

      expect(nodes.find((node) => node.projectRelativePath === directoryPath)).toMatchObject({
        nodeKind: 'directory',
        width: 3600,
        height: 960
      });
      expect(nodes.find((node) => node.projectRelativePath === unknownFilePath)).toMatchObject({
        nodeKind: 'file',
        mediaKind: 'unknown',
        width: 3600,
        height: 1200
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('routes direct source Project Document text edits through document transactions', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-source-doc-text-write-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, 'notes'), { recursive: true });
      await writeFile(join(projectRoot, 'notes/brief.md'), '# Brief\n', 'utf8');
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      const sourcePath = join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml');
      const previousSource = await readFile(sourcePath, 'utf8');
      await writeFile(`${sourcePath}.lock`, '', 'utf8');

      await expect(server.writeProjectTextFile('.debrute/canvas-maps/canvas-1.yaml', canvasMapSource(['notes/brief.md'])))
        .rejects.toMatchObject({ code: 'document_push_conflict' });
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe(previousSource);

      await rm(`${sourcePath}.lock`, { force: true });
      const written = await server.writeProjectTextFile('.debrute/canvas-maps/canvas-1.yaml', canvasMapSource(['notes/brief.md']));

      expect(written.projectRelativePath).toBe('.debrute/canvas-maps/canvas-1.yaml');
      expect(server.getSnapshot().canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual([
        '',
        'notes',
        'notes/brief.md'
      ]);
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toContain('notes/brief.md');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects generic text writes to non-source Project Documents', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-pushed-doc-text-write-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      const canvasPath = join(projectRoot, '.debrute/canvases/canvas-1.json');
      const previousCanvas = await readFile(canvasPath, 'utf8');

      await expect(server.writeProjectTextFile('.debrute/canvases/canvas-1.json', '{}\n'))
        .rejects.toMatchObject({ code: 'document_descriptor_violation' });
      await expect(readFile(canvasPath, 'utf8')).resolves.toBe(previousCanvas);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('refreshes project-visible ordinary file changes without requiring a Canvas Map', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-refresh-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      await mkdir(join(projectRoot, 'notes'), { recursive: true });
      await writeFile(join(projectRoot, 'notes/brief.md'), 'hello\n', 'utf8');
      const snapshot = await server.refreshProject();

      expect(snapshot.files.some((file) => file.projectRelativePath === 'notes/brief.md')).toBe(true);
      expect(snapshot.health.canvasCount).toBe(1);
      expect(snapshot.canvases[0]?.nodeElements).toEqual([]);
      expect(snapshot.diagnostics).toEqual([]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('syncs Canvas Map folder rules during project refresh', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-refresh-sync-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: async (input) => {
        if (input.nodeKind === 'directory') {
          return { width: 240, height: 96 };
        }
        return { width: 420, height: 280 };
      }
    });
    try {
      await mkdir(join(projectRoot, 'outputs/gpt'), { recursive: true });
      await writeFile(join(projectRoot, 'outputs/gpt/one.md'), '# One\n', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['outputs/gpt/']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      await server.refreshProject();
      await server.updateCanvasNodeLayouts({
        canvasId: 'canvas-1',
        nodeLayouts: [{ projectRelativePath: 'outputs/gpt/one.md', x: 999, y: 888, width: 777, height: 666 }]
      });
      await writeFile(join(projectRoot, 'outputs/gpt/two.md'), '# Two\n', 'utf8');

      const snapshot = await server.refreshProject();

      expect(snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual([
        '',
        'outputs',
        'outputs/gpt',
        'outputs/gpt/one.md',
        'outputs/gpt/two.md'
      ]);
      expect(snapshot.canvases[0]?.nodeElements.find((node) => node.projectRelativePath === 'outputs/gpt/one.md')).toMatchObject({
        x: 999,
        y: 888,
        width: 777,
        height: 666,
        layoutMode: 'manual'
      });
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toContain('outputs/gpt/two.md');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('pushes Canvas Map drift during interactive refresh', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-refresh-push-mode-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, 'notes'), { recursive: true });
      await writeFile(join(projectRoot, 'notes/a.md'), '# A\n', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['notes/a.md']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      await writeFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), canvasMapSource(['notes/*.md']), 'utf8');
      await writeFile(join(projectRoot, 'notes/b.md'), '# B\n', 'utf8');

      const snapshot = await server.refreshProject();

      expect(snapshot.diagnostics.find((diagnostic) => diagnostic.code === 'document_drift')).toBeUndefined();
      expect(snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual([
        '',
        'notes',
        'notes/a.md',
        'notes/b.md'
      ]);
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toContain('notes/b.md');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('applies visual-only Canvas updates without synchronizing Canvas Maps', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-visual-canvas-'));
    let layoutReadsAllowed = true;
    let layoutReadCount = 0;
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: async (input) => {
        layoutReadCount += 1;
        if (!layoutReadsAllowed) {
          throw new Error(`visual Canvas update synchronized Canvas Maps for ${input.projectRelativePath}`);
        }
        if (input.nodeKind === 'directory') {
          return { width: 240, height: 96 };
        }
        if (input.mediaKind === 'text') {
          return { width: 420, height: 280 };
        }
        return { width: 320, height: 180 };
      }
    });
    try {
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/generated/a.png'), await largePreviewablePngBuffer());
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['image-production/generated/*.png']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      const synced = await server.refreshProject();
      const nodePath = 'image-production/generated/a.png';
      const checkedAt = synced.health.checkedAt;
      const files = synced.files;
      const events: string[] = [];
      const unsubscribe = server.onEvent((event) => events.push(event.type));
      const layoutReadCountBeforeVisualUpdates = layoutReadCount;

      layoutReadsAllowed = false;
      const layout = await server.updateCanvasNodeLayouts({
        canvasId: 'canvas-1',
        nodeLayouts: [{ projectRelativePath: nodePath, x: 50, y: 60, width: 640, height: 360 }]
      });
      const layer = await server.updateCanvasNodeLayers({
        canvasId: 'canvas-1',
        nodeProjectRelativePathsTopFirst: ['image-production', 'image-production/generated', nodePath]
      });
      unsubscribe();

      expect(layout.canvas.nodeElements.find((node) => node.projectRelativePath === nodePath)).toMatchObject({ x: 50, y: 60, width: 640, height: 360, layoutMode: 'manual' });
      expect(layer.canvas.nodeElements.find((node) => node.projectRelativePath === 'image-production')).toMatchObject({ z: 3 });
      expect(layout.projection.canvasId).toBe('canvas-1');
      expect(layer.projection.canvasId).toBe('canvas-1');
      expect(layoutReadCount).toBe(layoutReadCountBeforeVisualUpdates);
      expect(events).toEqual(['canvas.changed', 'canvas.changed']);

      const snapshot = server.getSnapshot();
      expect(snapshot.files).toEqual(files);
      expect(snapshot.health.checkedAt).toBe(checkedAt);
      expect(snapshot.projections[0]!.nodes.find((node) => node.projectRelativePath === nodePath)).toMatchObject({
        x: 50,
        y: 60,
        width: 640,
        height: 360,
        availability: { state: 'available' }
      });
      const canvasJson = await readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8');
      expect(canvasJson).not.toContain('"viewport"');
      expect(canvasJson).not.toContain('"selection"');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('pushes Canvas Map source into Canvas JSON and preserves manual layout', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-push-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'outputs/gpt/a.png': { width: 100, height: 100 },
        'outputs/gpt/b.png': { width: 200, height: 50 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'outputs/gpt'), { recursive: true });
      await writeFile(join(projectRoot, 'outputs/gpt/a.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'outputs/gpt/b.png'), 'fake', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['outputs/gpt/']));

      await expect(server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' }))
        .resolves.toEqual({ ok: true, command: 'canvas-map.push', canvasId: 'canvas-1' });
      await server.refreshProject();
      await server.updateCanvasNodeLayouts({
        canvasId: 'canvas-1',
        nodeLayouts: [{ projectRelativePath: 'outputs/gpt/b.png', x: 999, y: 888, width: 777, height: 666 }]
      });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['outputs/gpt/b.png']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });

      const snapshot = await server.refreshProject();

      expect(snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual([
        '',
        'outputs',
        'outputs/gpt',
        'outputs/gpt/b.png'
      ]);
      expectNoAutomaticCanvasNodeOverlaps(snapshot.canvases[0]!.nodeElements);
      expect(snapshot.canvases[0]?.nodeElements.map((node) => [node.projectRelativePath, node.layoutMode])).toEqual([
        ['', undefined],
        ['outputs', undefined],
        ['outputs/gpt', undefined],
        ['outputs/gpt/b.png', 'manual']
      ]);
      expect(snapshot.canvases[0]?.nodeElements.find((node) => node.projectRelativePath === 'outputs/gpt/b.png')).toMatchObject({
        x: 999,
        y: 888,
        width: 777,
        height: 666
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('resets manual Canvas layout by all nodes and Canvas Map path rules', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-reset-layout-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'outputs/gpt/a.png': { width: 100, height: 100 },
        'outputs/gpt/b.png': { width: 100, height: 100 },
        'prompts/cover.md': { width: 420, height: 280 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'outputs/gpt'), { recursive: true });
      await mkdir(join(projectRoot, 'prompts'), { recursive: true });
      await writeFile(join(projectRoot, 'outputs/gpt/a.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'outputs/gpt/b.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'prompts/cover.md'), '# Cover\n', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([
        'outputs/gpt/',
        'prompts/cover.md'
      ]));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      await server.refreshProject();
      await server.updateCanvasNodeLayouts({
        canvasId: 'canvas-1',
        nodeLayouts: [
          { projectRelativePath: 'outputs', x: 2000, y: 1000 },
          { projectRelativePath: 'outputs/gpt', x: 2100, y: 1100 },
          { projectRelativePath: 'outputs/gpt/a.png', x: 2200, y: 1200 },
          { projectRelativePath: 'outputs/gpt/b.png', x: 2300, y: 1300 },
          { projectRelativePath: 'prompts/cover.md', x: 2400, y: 1400 }
        ]
      });

      const partial = await server.resetCanvasNodeLayouts({
        canvasId: 'canvas-1',
        pathRules: ['outputs/gpt/']
      });

      expect(partial.resetCount).toBe(3);
      expect(partial.canvas.nodeElements.map((node) => [node.projectRelativePath, node.layoutMode])).toEqual([
        ['', undefined],
        ['outputs', 'manual'],
        ['outputs/gpt', undefined],
        ['outputs/gpt/a.png', undefined],
        ['outputs/gpt/b.png', undefined],
        ['prompts', undefined],
        ['prompts/cover.md', 'manual']
      ]);
      expect(partial.canvas.nodeElements.find((node) => node.projectRelativePath === 'outputs/gpt/a.png')).not.toMatchObject({ x: 2200, y: 1200 });
      const resetA = partial.canvas.nodeElements.find((node) => node.projectRelativePath === 'outputs/gpt/a.png')!;
      const resetB = partial.canvas.nodeElements.find((node) => node.projectRelativePath === 'outputs/gpt/b.png')!;
      expect(resetB.x).toBeGreaterThan(resetA.x);
      expect(resetB.y).toBe(resetA.y);
      expect(partial.canvas.nodeElements.find((node) => node.projectRelativePath === 'prompts/cover.md')).toMatchObject({
        x: 2400,
        y: 1400,
        layoutMode: 'manual'
      });

      const all = await server.resetCanvasNodeLayouts({
        canvasId: 'canvas-1',
        all: true
      });

      expect(all.resetCount).toBe(2);
      expect(all.canvas.nodeElements.every((node) => node.layoutMode !== 'manual')).toBe(true);
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.not.toContain('"layoutMode"');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('validates Canvas Map source when reset layout matches no manual nodes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-reset-layout-noop-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'prompts/cover.md': { width: 420, height: 280 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'prompts'), { recursive: true });
      await writeFile(join(projectRoot, 'prompts/cover.md'), '# Cover\n', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['prompts/cover.md']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      await writeCanvasMap(projectRoot, 'canvas-1', 'paths:\n  - [broken\n');

      await expect(server.resetCanvasNodeLayouts({
        canvasId: 'canvas-1',
        pathRules: ['future/missing.md']
      })).rejects.toMatchObject({ code: 'canvas_map_invalid_yaml' });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('succeeds with reset count zero when reset layout path rules match no manual nodes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-reset-layout-zero-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'prompts/cover.md': { width: 420, height: 280 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'prompts'), { recursive: true });
      await writeFile(join(projectRoot, 'prompts/cover.md'), '# Cover\n', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['prompts/cover.md']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      await server.refreshProject();
      await server.updateCanvasNodeLayouts({
        canvasId: 'canvas-1',
        nodeLayouts: [{ projectRelativePath: 'prompts/cover.md', x: 1200, y: 900 }]
      });

      const reset = await server.resetCanvasNodeLayouts({
        canvasId: 'canvas-1',
        pathRules: ['future/missing.md']
      });

      expect(reset.resetCount).toBe(0);
      expect(reset.canvas.nodeElements.find((node) => node.projectRelativePath === 'prompts/cover.md')).toMatchObject({
        x: 1200,
        y: 900,
        layoutMode: 'manual'
      });
      expect(reset.canvas.nodeElements.map((node) => node.projectRelativePath)).toEqual([
        '',
        'prompts',
        'prompts/cover.md'
      ]);
      await expect(readFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), 'utf8'))
        .resolves.toBe(canvasMapSource(['prompts/cover.md']));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('applies Canvas Map layout rows when pushing into Canvas JSON', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-rows-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'outputs/gemini/high/a.png': { width: 100, height: 100 },
        'outputs/gemini/high/b.png': { width: 140, height: 80 },
        'outputs/gpt/high/a.png': { width: 100, height: 100 },
        'outputs/gpt/high/b.png': { width: 140, height: 80 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'outputs/gemini/high'), { recursive: true });
      await mkdir(join(projectRoot, 'outputs/gpt/high'), { recursive: true });
      await writeFile(join(projectRoot, 'outputs/gemini/high/a.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'outputs/gemini/high/b.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'outputs/gpt/high/a.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'outputs/gpt/high/b.png'), 'fake', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(
        ['outputs/**/*.png'],
        ['outputs/**/high/*.png']
      ));

      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });

      const nodes = (await server.refreshProject()).canvases[0]!.nodeElements;
      const geminiA = nodes.find((node) => node.projectRelativePath === 'outputs/gemini/high/a.png')!;
      const geminiB = nodes.find((node) => node.projectRelativePath === 'outputs/gemini/high/b.png')!;
      const gptA = nodes.find((node) => node.projectRelativePath === 'outputs/gpt/high/a.png')!;
      const gptB = nodes.find((node) => node.projectRelativePath === 'outputs/gpt/high/b.png')!;

      expect(geminiB.x).toBeGreaterThan(geminiA.x);
      expect(geminiA.y + geminiA.height / 2).toBe(geminiB.y + geminiB.height / 2);
      expect(gptB.x).toBeGreaterThan(gptA.x);
      expect(gptA.y + gptA.height / 2).toBe(gptB.y + gptB.height / 2);
      expectNoAutomaticCanvasNodeOverlaps(nodes);
      expect(nodes.find((node) => node.projectRelativePath === '')?.x).toBe(0);
      expect(nodes.find((node) => node.projectRelativePath === 'outputs')?.x).toBe(340);
      expect(nodes.find((node) => node.projectRelativePath === 'outputs/gemini')?.x).toBe(680);
      expect(nodes.find((node) => node.projectRelativePath === 'outputs/gemini/high')?.x).toBe(1020);
      expect(nodes.find((node) => node.projectRelativePath === 'outputs/gemini/high/a.png')?.x).toBe(1360);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('pushes Canvas Map default file rows and explicit row remainders into Canvas JSON', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-default-rows-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'outputs/gpt/a.png': { width: 100, height: 100 },
        'outputs/gpt/b.png': { width: 120, height: 80 },
        'outputs/gpt/c.png': { width: 80, height: 80 },
        'outputs/gpt/d.png': { width: 140, height: 100 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'outputs/gpt'), { recursive: true });
      await writeFile(join(projectRoot, 'outputs/gpt/a.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'outputs/gpt/b.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'outputs/gpt/c.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'outputs/gpt/d.png'), 'fake', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(
        ['outputs/gpt/'],
        ['outputs/gpt/[bd].png']
      ));

      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });

      const nodes = (await server.refreshProject()).canvases[0]!.nodeElements;
      const a = nodes.find((node) => node.projectRelativePath === 'outputs/gpt/a.png')!;
      const b = nodes.find((node) => node.projectRelativePath === 'outputs/gpt/b.png')!;
      const c = nodes.find((node) => node.projectRelativePath === 'outputs/gpt/c.png')!;
      const d = nodes.find((node) => node.projectRelativePath === 'outputs/gpt/d.png')!;

      expect(d.x).toBeGreaterThan(b.x);
      expect(b.y + b.height / 2).toBe(d.y + d.height / 2);
      expect(c.x).toBeGreaterThan(a.x);
      expect(a.y + a.height / 2).toBe(c.y + c.height / 2);
      expect(b.y).toBeLessThan(a.y);
      expectNoAutomaticCanvasNodeOverlaps(nodes);
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.not.toContain('layoutRows');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('pushes Canvas Map project root nodes and default rows for root-level files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-root-rows-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'outputs/gpt/a.png': { width: 100, height: 100 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'outputs/gpt'), { recursive: true });
      await writeFile(join(projectRoot, 'README.md'), '# Readme\n', 'utf8');
      await writeFile(join(projectRoot, 'brief.md'), '# Brief\n', 'utf8');
      await writeFile(join(projectRoot, 'outputs/gpt/a.png'), 'fake', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([
        'README.md',
        'brief.md',
        'outputs/gpt/'
      ]));

      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });

      const nodes = (await server.refreshProject()).canvases[0]!.nodeElements;
      const root = nodes.find((node) => node.projectRelativePath === '')!;
      const readme = nodes.find((node) => node.projectRelativePath === 'README.md')!;
      const brief = nodes.find((node) => node.projectRelativePath === 'brief.md')!;
      const outputs = nodes.find((node) => node.projectRelativePath === 'outputs')!;

      expect(nodes.map((node) => node.projectRelativePath)).toEqual([
        '',
        'brief.md',
        'outputs',
        'outputs/gpt',
        'outputs/gpt/a.png',
        'README.md'
      ]);
      expect(root).toMatchObject({ nodeKind: 'directory' });
      expect(brief.x).toBeGreaterThan(root.x);
      expect(readme.x).toBeGreaterThan(brief.x);
      expect(readme.y).toBe(brief.y);
      expect(readme.y).toBeLessThan(outputs.y);
      expectNoAutomaticCanvasNodeOverlaps(nodes);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('leaves Canvas JSON unchanged when Canvas Map push fails', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-invalid-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['missing/file.md']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      const before = await readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8');
      await mkdir(join(projectRoot, 'outputs/gpt'), { recursive: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['outputs/gpt']));

      await expect(server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' }))
        .rejects.toMatchObject({ code: 'canvas_map_invalid_path' });

      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toBe(before);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('aborts Canvas Map push when source changes before commit', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-push-conflict-'));
    let changedDuringPush = false;
    const mapPath = join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml');
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: async (input) => {
        if (!changedDuringPush && input.projectRelativePath === 'prompts/cover.md') {
          changedDuringPush = true;
          await writeFile(mapPath, canvasMapSource(['prompts/other.md']), 'utf8');
        }
        return { width: 420, height: 280 };
      }
    });
    try {
      await mkdir(join(projectRoot, 'prompts'), { recursive: true });
      await writeFile(join(projectRoot, 'prompts/cover.md'), '# Cover\n', 'utf8');
      await writeFile(join(projectRoot, 'prompts/other.md'), '# Other\n', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['prompts/cover.md']));
      const canvasBefore = await readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8');

      await expect(server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' }))
        .rejects.toMatchObject({ code: 'document_push_conflict' });

      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toBe(canvasBefore);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects Canvas Map push when the source is missing', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-missing-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });

      await expect(server.pushCanvasMapForProject(projectRoot, { canvasId: 'new-map' }))
        .rejects.toMatchObject({ code: 'canvas_map_read_failed' });
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toContain('"nodeElements": []');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects Canvas Map push for an unregistered Canvas without creating fallback Canvas files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-unregistered-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-2', 'paths: []\n');

      await expect(server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-2' }))
        .rejects.toMatchObject({ code: 'canvas_map_canvas_missing' });
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-2.json'), 'utf8')).rejects.toThrow();
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects Canvas Map push for an unregistered Canvas JSON and YAML pair', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-unregistered-pair-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeFile(join(projectRoot, '.debrute/canvases/canvas-2.json'), JSON.stringify(emptyCanvasDocument('canvas-2'), null, 2), 'utf8');
      await writeCanvasMap(projectRoot, 'canvas-2', 'paths: []\n');

      await expect(server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-2' }))
        .rejects.toMatchObject({ code: 'canvas_map_canvas_missing' });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('marks still raster images as Canvas-previewable in node availability', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-image-previewability-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'image-production/generated/large-still.png': { width: 900, height: 700 },
        'image-production/generated/small-still.png': { width: 320, height: 180 },
        'image-production/generated/animated.gif': { width: 320, height: 180 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(
        join(projectRoot, 'image-production/generated/large-still.png'),
        await largePreviewablePngBuffer()
      );
      await sharp({
        create: {
          width: 320,
          height: 180,
          channels: 4,
          background: '#336699ff'
        }
      }).png().toFile(join(projectRoot, 'image-production/generated/small-still.png'));
      await writeFile(join(projectRoot, 'image-production/generated/animated.gif'), 'gif placeholder', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([
        'image-production/generated/*.png',
        'image-production/generated/*.gif'
      ]));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });

      const nodes = (await server.refreshProject()).projections[0]!.nodes;

      expect(nodes.find((node) => node.projectRelativePath === 'image-production/generated/large-still.png')).toMatchObject({
        availability: { state: 'available', mimeType: 'image/png', canvasImagePreviewable: true, canvasImagePreviewSourceWidth: 900 }
      });
      expect(nodes.find((node) => node.projectRelativePath === 'image-production/generated/small-still.png')).toMatchObject({
        availability: { state: 'available', mimeType: 'image/png', canvasImagePreviewable: true, canvasImagePreviewSourceWidth: 320 }
      });
      expect(nodes.find((node) => node.projectRelativePath === 'image-production/generated/animated.gif')).toMatchObject({
        availability: { state: 'available', mimeType: 'image/gif', canvasImagePreviewable: false }
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('surfaces large raster metadata failures after Canvas Map push', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-image-preview-metadata-error-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'image-production/generated/broken.png': { width: 900, height: 700 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/generated/broken.png'), Buffer.alloc(1_600_000, 1));
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['image-production/generated/*.png']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });

      const nodes = (await server.refreshProject()).projections[0]!.nodes;

      expect(nodes.find((node) => node.projectRelativePath === 'image-production/generated/broken.png')).toMatchObject({
        availability: {
          state: 'unreadable',
          message: 'Canvas image preview metadata could not be read: image-production/generated/broken.png'
        }
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('preserves manual node layout and removes absent Canvas Map nodes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-manual-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'image-production/generated/a.png': { width: 100, height: 100 },
        'image-production/generated/b.png': { width: 200, height: 50 },
        'image-production/generated/c.png': { width: 80, height: 80 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/generated/b.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'image-production/generated/c.png'), 'fake', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['image-production/generated/*.png']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      await server.refreshProject();
      await server.updateCanvasNodeLayouts({
        canvasId: 'canvas-1',
        nodeLayouts: [{ projectRelativePath: 'image-production/generated/b.png', x: 999, y: 888, width: 777, height: 666 }]
      });
      await writeFile(join(projectRoot, 'image-production/generated/a.png'), 'fake', 'utf8');
      await rm(join(projectRoot, 'image-production/generated/c.png'), { force: true });
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });

      const snapshot = await server.refreshProject();

      expect(snapshot.canvases[0]?.nodeElements.map((node) => [node.projectRelativePath, node.layoutMode])).toEqual([
        ['', undefined],
        ['image-production', undefined],
        ['image-production/generated', undefined],
        ['image-production/generated/a.png', undefined],
        ['image-production/generated/b.png', 'manual']
      ]);
      expect(snapshot.canvases[0]?.nodeElements.find((node) => node.projectRelativePath === 'image-production/generated/b.png')).toMatchObject({
        x: 999,
        y: 888,
        width: 777,
        height: 666,
        layoutMode: 'manual'
      });
      expectNoAutomaticCanvasNodeOverlaps(snapshot.canvases[0]!.nodeElements);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('writes dragged files and folders into Canvas Map only when the source hash matches', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-drag-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'outputs/gpt/a.png': { width: 100, height: 100 },
        'prompts/cover.md': { width: 420, height: 280 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'outputs/gpt'), { recursive: true });
      await mkdir(join(projectRoot, 'prompts'), { recursive: true });
      await writeFile(join(projectRoot, 'outputs/gpt/a.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'prompts/cover.md'), '# Cover\n', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['prompts/cover.md']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      await server.refreshProject();

      const result = await server.addProjectPathToCanvasMap({
        canvasId: 'canvas-1',
        projectRelativePath: 'outputs/gpt'
      });

      expect(result.centerProjectRelativePath).toBe('outputs/gpt');
      await expect(readFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), 'utf8')).resolves.toBe(canvasMapSource([
        'prompts/cover.md',
        'outputs/gpt/'
      ]));
      expect(result.snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toContain('outputs/gpt/a.png');

      await writeFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), canvasMapSource([
        'prompts/cover.md',
        'external/edit.md'
      ]), 'utf8');
      await expect(server.addProjectPathToCanvasMap({
        canvasId: 'canvas-1',
        projectRelativePath: 'outputs/gpt/a.png'
      })).rejects.toMatchObject({ code: 'canvas_map_conflict' });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('allows a fresh app-server session to drag onto an already pushed Canvas Map', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-fresh-drag-'));
    const pusher = new DebruteAppServer();
    const workbench = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, 'prompts'), { recursive: true });
      await writeFile(join(projectRoot, 'prompts/cover.md'), '# Cover\n', 'utf8');
      await writeFile(join(projectRoot, 'prompts/alt.md'), '# Alt\n', 'utf8');
      await pusher.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['prompts/cover.md']));
      await pusher.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      pusher.close();

      await workbench.openProject(projectRoot, { initializeIfMissing: false, createDefaultCanvas: false });
      const result = await workbench.addProjectPathToCanvasMap({
        canvasId: 'canvas-1',
        projectRelativePath: 'prompts/alt.md'
      });

      expect(result.centerProjectRelativePath).toBe('prompts/alt.md');
      expect(result.snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual(expect.arrayContaining([
        'prompts',
        'prompts/cover.md',
        'prompts/alt.md'
      ]));
      await expect(readFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), 'utf8')).resolves.toBe(canvasMapSource([
        'prompts/cover.md',
        'prompts/alt.md'
      ]));
    } finally {
      pusher.close();
      workbench.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('allows fresh-session drag after opening synchronizes Canvas Map layout rows', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-fresh-drag-row-sync-'));
    const pusher = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'prompts/cover.md': { width: 420, height: 280 },
        'prompts/alt.md': { width: 420, height: 280 },
        'prompts/extra.md': { width: 420, height: 280 }
      })
    });
    const workbench = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'prompts/cover.md': { width: 420, height: 280 },
        'prompts/alt.md': { width: 420, height: 280 },
        'prompts/extra.md': { width: 420, height: 280 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'prompts'), { recursive: true });
      await writeFile(join(projectRoot, 'prompts/cover.md'), '# Cover\n', 'utf8');
      await writeFile(join(projectRoot, 'prompts/alt.md'), '# Alt\n', 'utf8');
      await writeFile(join(projectRoot, 'prompts/extra.md'), '# Extra\n', 'utf8');
      await pusher.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([
        'prompts/cover.md',
        'prompts/alt.md'
      ]));
      await pusher.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      pusher.close();
      const unpushedSource = canvasMapSource([
        'prompts/cover.md',
        'prompts/alt.md'
      ], ['prompts/*.md']);
      await writeCanvasMap(projectRoot, 'canvas-1', unpushedSource);

      await workbench.openProject(projectRoot, { initializeIfMissing: false, createDefaultCanvas: false });
      const result = await workbench.addProjectPathToCanvasMap({
        canvasId: 'canvas-1',
        projectRelativePath: 'prompts/extra.md'
      });

      expect(result.snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual([
        '',
        'prompts',
        'prompts/alt.md',
        'prompts/cover.md',
        'prompts/extra.md'
      ]);
      await expect(readFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), 'utf8')).resolves.toBe(canvasMapSource([
        'prompts/cover.md',
        'prompts/alt.md',
        'prompts/extra.md'
      ], ['prompts/*.md']));
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toContain('prompts/extra.md');
    } finally {
      pusher.close();
      workbench.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not write Canvas Map YAML when drag push validation fails', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-map-drag-atomic-'));
    const server = new DebruteAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'prompts/cover.md': { width: 420, height: 280 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'prompts'), { recursive: true });
      await mkdir(join(projectRoot, 'outputs'), { recursive: true });
      await writeFile(join(projectRoot, 'prompts/cover.md'), '# Cover\n', 'utf8');
      await writeFile(join(projectRoot, 'outputs/bad.png'), 'not a png', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['prompts/cover.md']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      const canvasBefore = await readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8');

      await expect(server.addProjectPathToCanvasMap({
        canvasId: 'canvas-1',
        projectRelativePath: 'outputs/bad.png'
      })).rejects.toMatchObject({ code: 'canvas_map_invalid_path' });

      await expect(readFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), 'utf8')).resolves.toBe(canvasMapSource(['prompts/cover.md']));
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toBe(canvasBefore);
      expect(server.getSnapshot().canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).not.toContain('outputs/bad.png');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects visual Canvas writes when Canvas JSON changed after the snapshot was loaded', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-canvas-visual-conflict-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, 'prompts'), { recursive: true });
      await writeFile(join(projectRoot, 'prompts/cover.md'), '# Cover\n', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['prompts/cover.md']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      await server.refreshProject();
      const canvasPath = join(projectRoot, '.debrute/canvases/canvas-1.json');
      const externalCanvas = {
        ...(await readJson(canvasPath) as Record<string, unknown>),
        nodeElements: (server.getSnapshot().canvases[0]?.nodeElements ?? []).map((node) => (
          node.projectRelativePath === 'prompts/cover.md'
            ? { ...node, x: 321, y: 654, layoutMode: 'manual' }
            : node
        ))
      };
      await writeFile(canvasPath, `${JSON.stringify(externalCanvas, null, 2)}\n`, 'utf8');

      await expect(server.updateCanvasNodeLayouts({
        canvasId: 'canvas-1',
        nodeLayouts: [{ projectRelativePath: 'prompts/cover.md', x: 1, y: 2 }]
      })).rejects.toMatchObject({ code: 'document_push_conflict' });
      await expect(readJson(canvasPath)).resolves.toEqual(externalCanvas);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('accepts registry-backed empty Canvas views', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-empty-canvas-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
      await mkdir(join(projectRoot, '.debrute/canvas-maps'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: {
          id: 'project-empty-canvas',
          name: 'Empty Canvas',
          createdAt: '2026-05-23T10:30:00.000Z',
          updatedAt: '2026-05-23T10:30:00.000Z'
        }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), JSON.stringify({
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
        id: 'canvas-1',
        nodeElements: [],
        annotations: [],
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), 'paths: []\n', 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/index.json'), JSON.stringify({
        schemaVersion: 1,
        canvasOrder: ['canvas-1']
      }, null, 2), 'utf8');

      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      });

      expect(snapshot.canvases[0]?.nodeElements).toEqual([]);
      expect(snapshot.projections[0]?.edges).toEqual([]);
      expect(snapshot.diagnostics).toEqual([]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function writeCanvasMap(projectRoot: string, canvasId: string, content: string): Promise<void> {
  await mkdir(join(projectRoot, '.debrute/canvas-maps'), { recursive: true });
  await writeFile(join(projectRoot, `.debrute/canvas-maps/${canvasId}.yaml`), content, 'utf8');
}

function canvasMapSource(paths: string[], layoutRows: string[] = []): string {
  return [
    'paths:',
    ...paths.map((path) => `  - ${path}`),
    ...(layoutRows.length === 0
      ? []
      : [
          'layout:',
          '  rows:',
          ...layoutRows.map((row) => `    - ${row}`)
        ]),
    ''
  ].join('\n');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function emptyCanvasDocument(id: string) {
  return {
    schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
    id,
    nodeElements: [],
    annotations: [],
    preferences: { showDiagnostics: true }
  };
}

async function largePreviewablePngBuffer(): Promise<Buffer> {
  const width = 900;
  const height = 700;
  return sharp(randomBytes(width * height * 3), {
    raw: {
      width,
      height,
      channels: 3
    }
  }).png().toBuffer();
}

function expectNoAutomaticCanvasNodeOverlaps(nodes: Array<{
  projectRelativePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layoutMode?: 'manual';
}>): void {
  const automatic = nodes.filter((node) => node.layoutMode !== 'manual');
  for (const [index, left] of automatic.entries()) {
    for (const right of automatic.slice(index + 1)) {
      expect(canvasNodeRectsOverlap(left, right), `${left.projectRelativePath} overlaps ${right.projectRelativePath}`).toBe(false);
    }
  }
}

function canvasNodeRectsOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function canvasLayoutSizeReader(sizes: Record<string, { width: number; height: number }>) {
  return async (input: { projectRelativePath: string; nodeKind: string; mediaKind: string }) => {
    if (input.nodeKind === 'directory') {
      return { width: 240, height: 96 };
    }
    if (input.mediaKind === 'text') {
      return { width: 420, height: 280 };
    }
    if (input.mediaKind === 'audio') {
      return { width: 320, height: 96 };
    }
    if (input.mediaKind === 'unknown') {
      return { width: 260, height: 120 };
    }
    const size = sizes[input.projectRelativePath];
    if (!size) {
      throw new Error(`missing test dimensions: ${input.projectRelativePath}`);
    }
    return size;
  };
}
