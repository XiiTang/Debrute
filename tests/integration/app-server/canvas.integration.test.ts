import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canvasTextPreviewSourceProjectPath,
  createCanvasDocument,
  type CanvasProjection,
  canvasNodeStackOrderTopFirst
} from '@debrute/canvas-core';
import {
  assertCurrentCanvasDocument,
  canvasMediaKindFromPath,
  CanvasProjectionService
} from '../../../apps/app-server/src/canvas/CanvasProjectionService';
import { readCanvasNodeLayoutSize } from '../../../apps/app-server/src/canvas/CanvasNodeDimensionsService';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import sharp from 'sharp';
import { DebruteAppServer } from '@debrute/app-server';

describe('app-server Canvas', () => {
  describe('CanvasProjectionService Canvas document validation', () => {
    it('accepts current Canvas documents with a stored display name', () => {
      const canvas = createCanvasDocument({ id: 'canvas-1' });
      expect(assertCurrentCanvasDocument({
        ...canvas,
        name: '故事板'
      }, '/project/.debrute/canvases/canvas-1.json')).toMatchObject({
        id: 'canvas-1',
        name: '故事板'
      });
    });

    it('rejects Canvas documents without a current-schema display name', () => {
      const canvas = createCanvasDocument({ id: 'canvas-1' });
      const { name: _name, ...missingName } = canvas;
      expect(() => assertCurrentCanvasDocument(
        missingName,
        '/project/.debrute/canvases/canvas-1.json'
      )).toThrow('Invalid canvas document: /project/.debrute/canvases/canvas-1.json');
      expect(() => assertCurrentCanvasDocument({
        ...canvas,
        name: '  story  '
      }, '/project/.debrute/canvases/canvas-1.json')).toThrow('Invalid canvas document: /project/.debrute/canvases/canvas-1.json');
      expect(() => assertCurrentCanvasDocument({
        ...canvas,
        name: ''
      }, '/project/.debrute/canvases/canvas-1.json')).toThrow('Invalid canvas document: /project/.debrute/canvases/canvas-1.json');
    });

    it('accepts textViewport only on text file nodes', () => {
      const canvas = createCanvasDocument({ id: 'canvas-1' });
      expect(assertCurrentCanvasDocument({
        ...canvas,
        nodeElements: [{
          ...canvasTextFileNode('notes/readme.md'),
          textViewport: { scrollTop: 72, scrollLeft: 9 }
        }]
      }, '/project/.debrute/canvases/canvas-1.json')).toMatchObject({
        nodeElements: [{
          projectRelativePath: 'notes/readme.md',
          textViewport: { scrollTop: 72, scrollLeft: 9 }
        }]
      });
      expect(() => assertCurrentCanvasDocument({
        ...canvas,
        nodeElements: [{
          projectRelativePath: 'media/image.png',
          nodeKind: 'file' as const,
          mediaKind: 'image' as const,
          x: 0,
          y: 0,
          width: 320,
          height: 180,
          z: 0,
          textViewport: { scrollTop: 72, scrollLeft: 9 }
        }]
      }, '/project/.debrute/canvases/canvas-1.json')).toThrow('Invalid canvas document: /project/.debrute/canvases/canvas-1.json');
      expect(() => assertCurrentCanvasDocument({
        ...canvas,
        nodeElements: [{
          ...canvasTextFileNode('notes/readme.md'),
          textViewport: { scrollTop: -1, scrollLeft: 0 }
        }]
      }, '/project/.debrute/canvases/canvas-1.json')).toThrow('Invalid canvas document: /project/.debrute/canvases/canvas-1.json');
    });

    it('projects available video nodes with video presentation companions', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-projection-'));
      try {
        await mkdir(join(projectRoot, 'media'), { recursive: true });
        await writeFile(join(projectRoot, 'media/clip.mp4'), 'video', 'utf8');
        await writeFile(join(projectRoot, 'media/clip.en.vtt'), 'WEBVTT\n', 'utf8');
        const canvas = {
          ...createCanvasDocument({ id: 'canvas-1' }),
          nodeElements: [{
            projectRelativePath: 'media/clip.mp4',
            nodeKind: 'file' as const,
            mediaKind: 'video' as const,
            x: 0,
            y: 0,
            width: 640,
            height: 360,
            z: 0
          }]
        };
        const projectionService = new CanvasProjectionService({
          readCanvasVideoMetadata: async () => ({ width: 640, height: 360, durationSeconds: 5 })
        });
        const projection = await projectionService.projectCanvasDocument(projectRoot, canvas);
        expect(projection.nodes[0]).toMatchObject({
          mediaKind: 'video',
          videoPresentation: {
            kind: 'video',
            width: 640,
            height: 360,
            durationSeconds: 5,
            textTracks: [
              expect.objectContaining({
                projectRelativePath: 'media/clip.en.vtt',
                kind: 'subtitles',
                srclang: 'en',
                default: true
              })
            ]
          }
        });
        expect(projection.nodes[0]?.videoPresentation?.textTracks[0]).not.toHaveProperty('fileUrl');
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('preserves projected video presentation while reprojecting a changed Canvas document', () => {
      const node = {
        projectRelativePath: 'media/clip.mp4',
        nodeKind: 'file' as const,
        mediaKind: 'video' as const,
        x: 0,
        y: 0,
        width: 640,
        height: 360,
        z: 0
      };
      const canvas = {
        ...createCanvasDocument({ id: 'canvas-1' }),
        nodeElements: [node]
      };
      const presentation = {
        kind: 'video' as const,
        width: 640,
        height: 360,
        durationSeconds: 5,
        textTracks: []
      };
      const projection: CanvasProjection = {
        canvasId: canvas.id,
        nodes: [{
          ...node,
          availability: {
            state: 'available',
            size: 100,
            mimeType: 'video/mp4',
            fileUrl: '/api/projects/p/files/raw/media/clip.mp4?v=rev-a',
            revision: 'rev-a'
          },
          videoPresentation: presentation
        }],
        edges: [],
        diagnostics: []
      };
      const projectionService = new CanvasProjectionService({
        readCanvasVideoMetadata: async () => ({ width: 640, height: 360 })
      });
      const next = projectionService.projectCanvasWithKnownProjection({
        ...canvas,
        nodeElements: [{ ...node, x: 80, y: 90 }]
      }, projection);
      expect(next.nodes[0]).toMatchObject({
        projectRelativePath: 'media/clip.mp4',
        x: 80,
        y: 90,
        videoPresentation: presentation
      });
    });
    it.each([
      ['subtitles/captions.srt', 'text/plain'],
      ['subtitles/captions.vtt', 'text/vtt'],
      ['config/app.toml', 'application/toml'],
      ['papers/story.tex', 'application/x-tex'],
      ['docs/page.textile', 'text/x-textile'],
      ['schema/messages.proto', 'text/x-protobuf'],
      ['docs/index.rst', 'text/x-rst'],
      ['docs/guide.adoc', 'text/x-asciidoc'],
      ['notes/tasks.org', 'text/x-org'],
      ['README', 'text/plain']
    ] as const)('projects %s as a text Canvas node with %s', async (projectRelativePath, mimeType) => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-format-projection-'));
      try {
        await mkdir(join(projectRoot, 'subtitles'), { recursive: true });
        await mkdir(join(projectRoot, 'config'), { recursive: true });
        await mkdir(join(projectRoot, 'papers'), { recursive: true });
        await mkdir(join(projectRoot, 'docs'), { recursive: true });
        await mkdir(join(projectRoot, 'schema'), { recursive: true });
        await mkdir(join(projectRoot, 'notes'), { recursive: true });
        await writeFile(join(projectRoot, projectRelativePath), 'sample text\n', 'utf8');
        expect(canvasMediaKindFromPath(projectRelativePath)).toBe('text');
        const canvas = {
          ...createCanvasDocument({ id: 'canvas-1' }),
          nodeElements: [canvasTextFileNode(projectRelativePath)]
        };
        const projectionService = new CanvasProjectionService({
          readCanvasVideoMetadata: async () => ({ width: 640, height: 360 })
        });
        const projection = await projectionService.projectCanvasDocument(projectRoot, canvas);
        expect(projection.nodes[0]).toMatchObject({
          projectRelativePath,
          mediaKind: 'text',
          availability: {
            state: 'available',
            mimeType
          }
        });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
    it.each([
      'subtitles/captions.sub',
      'brief.pdf',
      'brief.docx',
      'brief.pptx',
      'brief.xlsx',
      'brief.epub'
    ])('does not classify unsupported binary document %s as Canvas text', (projectRelativePath) => {
      expect(canvasMediaKindFromPath(projectRelativePath)).toBe('unknown');
    });
  });
  function canvasTextFileNode(projectRelativePath: string) {
    return {
      projectRelativePath,
      nodeKind: 'file' as const,
      mediaKind: 'text' as const,
      x: 0,
      y: 0,
      width: 420,
      height: 260,
      z: 0
    };
  }
  const PROJECT_ROOT = '/project';
  describe('CanvasNodeDimensionsService', () => {
    it('returns compact minimum automatic dimensions for short generic names', async () => {
      await expect(readCanvasNodeLayoutSize({
        projectRoot: PROJECT_ROOT,
        projectRelativePath: 'assets',
        nodeKind: 'directory',
        mediaKind: 'unknown'
      })).resolves.toEqual({ width: 1800, height: 640 });
      await expect(readCanvasNodeLayoutSize({
        projectRoot: PROJECT_ROOT,
        projectRelativePath: 'archive.bin',
        nodeKind: 'file',
        mediaKind: 'unknown'
      })).resolves.toEqual({ width: 1800, height: 640 });
    });

    it('expands generic automatic width from display-name text plus chrome', async () => {
      await expect(readCanvasNodeLayoutSize({
        projectRoot: PROJECT_ROOT,
        projectRelativePath: 'assets/abcdefghijklmnopqrstuv',
        nodeKind: 'directory',
        mediaKind: 'unknown'
      })).resolves.toEqual({ width: 2320, height: 640 });
      await expect(readCanvasNodeLayoutSize({
        projectRoot: PROJECT_ROOT,
        projectRelativePath: 'exports/abcdefghijklmnopqrstuv.dat',
        nodeKind: 'file',
        mediaKind: 'unknown'
      })).resolves.toEqual({ width: 2640, height: 640 });
    });

    it('clamps very long generic automatic widths to the final maximum', async () => {
      const longName = 'a'.repeat(120);
      await expect(readCanvasNodeLayoutSize({
        projectRoot: PROJECT_ROOT,
        projectRelativePath: `assets/${longName}`,
        nodeKind: 'directory',
        mediaKind: 'unknown'
      })).resolves.toEqual({ width: 7200, height: 640 });
      await expect(readCanvasNodeLayoutSize({
        projectRoot: PROJECT_ROOT,
        projectRelativePath: `exports/${longName}.bin`,
        nodeKind: 'file',
        mediaKind: 'unknown'
      })).resolves.toEqual({ width: 7200, height: 640 });
    });

    it('keeps existing fixed dimensions for text and audio nodes', async () => {
      await expect(readCanvasNodeLayoutSize({
        projectRoot: PROJECT_ROOT,
        projectRelativePath: 'notes/readme.md',
        nodeKind: 'file',
        mediaKind: 'text'
      })).resolves.toEqual({ width: 4200, height: 2800 });
      await expect(readCanvasNodeLayoutSize({
        projectRoot: PROJECT_ROOT,
        projectRelativePath: 'audio/theme.wav',
        nodeKind: 'file',
        mediaKind: 'audio'
      })).resolves.toEqual({ width: 3200, height: 960 });
    });
  });

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

  it('uses the integration PATH when projecting video metadata during project refresh', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-video-env-path-'));
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-app-server-video-env-bin-'));
    const server = new DebruteAppServer({
      integrationEnvPath: binDir,
      canvasNodeLayoutSizeReader: async () => ({ width: 640, height: 360 }),
      canvasVideoMetadataReader: async () => ({ width: 640, height: 360, durationSeconds: 5 })
    });
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-bytes', 'utf8');
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['media/clip.mp4']));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      const snapshot = await server.refreshProject();
      const videoNode = snapshot.projections[0]?.nodes.find((node) => node.projectRelativePath === 'media/clip.mp4');
      expect(videoNode).toMatchObject({
        projectRelativePath: 'media/clip.mp4',
        availability: { state: 'available' },
        videoPresentation: {
          kind: 'video',
          durationSeconds: 5
        }
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
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
      const renamed = await server.renameCanvas({ canvasId: 'canvas-2', name: 'Storyboard' });
      expect(renamed.activeCanvasId).toBe('canvas-2');
      expect(renamed.snapshot.canvases.map((canvas) => [canvas.id, canvas.name])).toEqual([
        ['canvas-1', 'canvas-1'],
        ['canvas-2', 'Storyboard']
      ]);
      await expect(readFile(join(projectRoot, '.debrute/canvas-maps/canvas-2.yaml'), 'utf8')).resolves.toBe('paths: []\n');
      expect(await readJson(join(projectRoot, '.debrute/canvases/canvas-2.json'))).toMatchObject({ id: 'canvas-2', name: 'Storyboard' });
      const reordered = await server.reorderCanvases({ canvasOrder: ['canvas-2', 'canvas-1'] });
      expect(reordered.snapshot.canvases.map((canvas) => canvas.id)).toEqual(['canvas-2', 'canvas-1']);
      const deleted = await server.deleteCanvas({ canvasId: 'canvas-2' });
      expect(deleted.activeCanvasId).toBe('canvas-1');
      expect(deleted.snapshot.canvases.map((canvas) => canvas.id)).toEqual(['canvas-1']);
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-2.json'), 'utf8')).rejects.toThrow();
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
        canvasOrder: ['canvas-2', 'canvas-1']
      }, null, 2), 'utf8');
      await expect(server.reorderCanvases({ canvasOrder: ['canvas-1', 'canvas-2'] })).rejects.toMatchObject({
        code: 'canvas_registry_conflict'
      });
      await server.refreshProject();
      await writeFile(join(projectRoot, '.debrute/canvas-maps/canvas-2.yaml'), 'paths:\n  - changed.md\n', 'utf8');
      const renamed = await server.renameCanvas({ canvasId: 'canvas-2', name: 'Storyboard' });
      expect(renamed.snapshot.canvases.find((canvas) => canvas.id === 'canvas-2')).toMatchObject({ name: 'Storyboard' });
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
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify(projectMetadata('Broken Canvas Project'), null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), JSON.stringify({
        id: 'canvas-1',
        nodeElements: 'bad',
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
          message: expect.stringContaining('Invalid canvas document'),
          filePath: join(projectRoot, '.debrute/canvases/canvas-1.json'),
          entityId: 'canvas-1'
        })
      ]));
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toContain('"nodeElements": "bad"');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not create a default canvas over an invalid pushed document', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-invalid-canvas-default-open-'));
    const server = new DebruteAppServer();
    const invalidCanvas = '{"id":"canvas-1","nodeElements":"bad","annotations":[],"preferences":{"showDiagnostics":true}}\n';
    try {
      await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify(projectMetadata('Broken Canvas Project'), null, 2), 'utf8');
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
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify(projectMetadata('Unsafe Canvas Project'), null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), JSON.stringify({
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

  it('accepts manual Canvas node layout mode in current Canvas JSON', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-manual-layout-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
      await mkdir(join(projectRoot, '.debrute/canvas-maps'), { recursive: true });
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/generated/a.md'), 'fake', 'utf8');
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify(projectMetadata('Manual Layout Project'), null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), JSON.stringify({
        id: 'canvas-1',
        name: 'canvas-1',
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
        canvasOrder: ['canvas-1']
      }, null, 2), 'utf8');
      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      });
      expect(snapshot.canvases[0]?.nodeElements.find(
        (node) => node.projectRelativePath === 'image-production/generated/a.md'
      )).toMatchObject({ layoutMode: 'manual' });
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
      await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify(projectMetadata('Auto Layout Mode Project'), null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), JSON.stringify({
        id: 'canvas-1',
        name: 'canvas-1',
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
          message: expect.stringContaining('Invalid canvas document'),
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
      await writeFile(join(projectRoot, 'notes/output.md'), 'draft\n', 'utf8');
      const textFile = await server.readProjectTextFile('notes/brief.md');
      const opened = await server.readProjectTextFile('notes/output.md');
      const written = await server.writeProjectTextFile({
        projectRelativePath: 'notes/output.md',
        content: 'done\n',
        expectedRevision: opened.revision
      });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([{ glob: 'notes/*.md' }]));
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

  it('projects supported text formats on Canvas through the shared text registry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-text-format-registry-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, 'batch'), { recursive: true });
      await mkdir(join(projectRoot, 'scripts'), { recursive: true });
      await mkdir(join(projectRoot, 'logs'), { recursive: true });
      await mkdir(join(projectRoot, 'config'), { recursive: true });
      await mkdir(join(projectRoot, 'bin'), { recursive: true });
      await mkdir(join(projectRoot, 'src'), { recursive: true });
      await mkdir(join(projectRoot, 'assets'), { recursive: true });
      await writeFile(join(projectRoot, 'batch/requests.jsonl'), '{"prompt":"one"}\n', 'utf8');
      await writeFile(join(projectRoot, 'scripts/run.sh'), '#!/usr/bin/env bash\necho run\n', 'utf8');
      await writeFile(join(projectRoot, 'logs/results.log'), 'ok\n', 'utf8');
      await writeFile(join(projectRoot, 'config/.env.local'), 'MODEL=gpt-image-2\n', 'utf8');
      await writeFile(join(projectRoot, '.gitignore'), 'node_modules\n', 'utf8');
      await writeFile(join(projectRoot, 'bin/run'), '#!/usr/bin/env bash\necho run\n', 'utf8');
      await writeFile(join(projectRoot, 'Dockerfile'), 'FROM node:24\n', 'utf8');
      await writeFile(join(projectRoot, 'Makefile'), 'all:\n\tpnpm check\n', 'utf8');
      await writeFile(join(projectRoot, 'LICENSE'), 'Apache-2.0\n', 'utf8');
      await writeFile(join(projectRoot, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
      await writeFile(join(projectRoot, 'src/module.mts'), 'export const value = 1;\n', 'utf8');
      await writeFile(join(projectRoot, 'assets/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" />\n', 'utf8');
      await writeFile(join(projectRoot, 'assets/cover.png'), await largePreviewablePngBuffer());
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([
        'batch/requests.jsonl',
        'scripts/run.sh',
        'logs/results.log',
        'config/.env.local',
        '.gitignore',
        'bin/run',
        'Dockerfile',
        'Makefile',
        'LICENSE',
        'tsconfig.json',
        'src/module.mts',
        'assets/icon.svg',
        'assets/cover.png'
      ]));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      const nodes = (await server.refreshProject()).projections[0]!.nodes;
      const byPath = new Map(nodes.map((node) => [node.projectRelativePath, node]));
      expect(byPath.get('batch/requests.jsonl')).toMatchObject({
        mediaKind: 'text',
        availability: { state: 'available', mimeType: 'application/jsonl' }
      });
      expect(byPath.get('scripts/run.sh')).toMatchObject({
        mediaKind: 'text',
        availability: { state: 'available', mimeType: 'text/x-shellscript' }
      });
      expect(byPath.get('logs/results.log')).toMatchObject({
        mediaKind: 'text',
        availability: { state: 'available', mimeType: 'text/plain' }
      });
      expect(byPath.get('config/.env.local')).toMatchObject({
        mediaKind: 'text',
        availability: { state: 'available', mimeType: 'text/plain' }
      });
      expect(byPath.get('.gitignore')).toMatchObject({
        mediaKind: 'text',
        availability: { state: 'available', mimeType: 'text/plain' }
      });
      expect(byPath.get('bin/run')).toMatchObject({
        mediaKind: 'text',
        availability: { state: 'available', mimeType: 'text/x-shellscript' }
      });
      expect(byPath.get('Dockerfile')).toMatchObject({
        mediaKind: 'text',
        availability: { state: 'available', mimeType: 'text/plain' }
      });
      expect(byPath.get('Makefile')).toMatchObject({
        mediaKind: 'text',
        availability: { state: 'available', mimeType: 'text/plain' }
      });
      expect(byPath.get('LICENSE')).toMatchObject({
        mediaKind: 'text',
        availability: { state: 'available', mimeType: 'text/plain' }
      });
      expect(byPath.get('tsconfig.json')).toMatchObject({
        mediaKind: 'text',
        availability: { state: 'available', mimeType: 'application/jsonc' }
      });
      expect(byPath.get('src/module.mts')).toMatchObject({
        mediaKind: 'text',
        availability: { state: 'available', mimeType: 'text/typescript' }
      });
      expect(byPath.get('assets/icon.svg')).toMatchObject({
        mediaKind: 'image',
        availability: { state: 'available', mimeType: 'image/svg+xml' }
      });
      expect(byPath.get('assets/cover.png')).toMatchObject({
        mediaKind: 'image',
        availability: { state: 'available', mimeType: 'image/png' }
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('projects supported image formats on Canvas through the shared image registry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-image-format-registry-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, 'assets'), { recursive: true });
      const png = await sharp({
        create: { width: 32, height: 24, channels: 4, background: '#336699ff' }
      }).png().toBuffer();
      const jpeg = await sharp({
        create: { width: 32, height: 24, channels: 3, background: '#884422' }
      }).jpeg().toBuffer();
      const webp = await sharp({
        create: { width: 32, height: 24, channels: 4, background: '#113355ff' }
      }).webp().toBuffer();
      const avif = await sharp({
        create: { width: 32, height: 24, channels: 4, background: '#225533ff' }
      }).avif().toBuffer();
      const tiff = await sharp({
        create: { width: 32, height: 24, channels: 4, background: '#663399ff' }
      }).tiff().toBuffer();
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#336699"/></svg>';
      await writeFile(join(projectRoot, 'assets/cover.png'), png);
      await writeFile(join(projectRoot, 'assets/photo.jpe'), jpeg);
      await writeFile(join(projectRoot, 'assets/photo.jfif'), jpeg);
      await writeFile(join(projectRoot, 'assets/render.webp'), webp);
      await writeFile(join(projectRoot, 'assets/render.avif'), avif);
      await writeFile(join(projectRoot, 'assets/scan.tif'), tiff);
      await writeFile(join(projectRoot, 'assets/scan.tiff'), tiff);
      await writeFile(join(projectRoot, 'assets/icon.svg'), svg, 'utf8');
      await writeFile(join(projectRoot, 'assets/icon.svgz'), await gzipBuffer(Buffer.from(svg)));
      await writeFile(join(projectRoot, 'assets/animated.gif'), Buffer.from('GIF89a'));
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([
        { glob: 'assets/*' }
      ]));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      const nodes = (await server.refreshProject()).projections[0]!.nodes;
      const byPath = new Map(nodes.map((node) => [node.projectRelativePath, node]));
      for (const [path, mimeType] of [
        ['assets/cover.png', 'image/png'],
        ['assets/photo.jpe', 'image/jpeg'],
        ['assets/photo.jfif', 'image/jpeg'],
        ['assets/render.webp', 'image/webp'],
        ['assets/render.avif', 'image/avif'],
        ['assets/scan.tif', 'image/tiff'],
        ['assets/scan.tiff', 'image/tiff'],
        ['assets/icon.svg', 'image/svg+xml'],
        ['assets/icon.svgz', 'image/svg+xml']
      ] as const) {
        expect(byPath.get(path)).toMatchObject({
          mediaKind: 'image',
          availability: { state: 'available', mimeType, canvasImagePreviewable: true }
        });
      }
      expect(byPath.get('assets/animated.gif')).toMatchObject({
        mediaKind: 'unknown',
        availability: { state: 'available', mimeType: 'text/plain' }
      });
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
        width: 4160,
        height: 640
      });
      expect(nodes.find((node) => node.projectRelativePath === unknownFilePath)).toMatchObject({
        nodeKind: 'file',
        mediaKind: 'unknown',
        width: 4160,
        height: 640
      });
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
      await writeFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), canvasMapSource([{ glob: 'notes/*.md' }]), 'utf8');
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
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([{ glob: 'image-production/generated/*.png' }]));
      await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
      const synced = await server.refreshProject();
      const nodePath = 'image-production/generated/a.png';
      const checkedAt = synced.health.checkedAt;
      const files = synced.files;
      const events: string[] = [];
      const unsubscribe = server.onEvent((event) => events.push(event.type));
      const layoutReadCountBeforeVisualUpdates = layoutReadCount;
      const stackOrderPath = 'image-production';
      layoutReadsAllowed = false;
      const layout = await server.updateCanvasNodeLayouts({
        canvasId: 'canvas-1',
        nodeLayouts: [{ projectRelativePath: nodePath, x: 50, y: 60, width: 640, height: 360 }]
      });
      const stackOrder = await server.bringCanvasNodeToFront({
        canvasId: 'canvas-1',
        projectRelativePath: stackOrderPath
      });
      unsubscribe();
      expect(layout.canvas.nodeElements.find((node) => node.projectRelativePath === nodePath)).toMatchObject({
        x: 50,
        y: 60,
        width: 640,
        height: 360,
        layoutMode: 'manual'
      });
      expect(canvasNodeStackOrderTopFirst(stackOrder.canvas)[0]).toBe(stackOrderPath);
      expect(layout.projection.canvasId).toBe('canvas-1');
      expect(stackOrder.projection.canvasId).toBe('canvas-1');
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
        pathRules: { paths: ['outputs/gpt/'] }
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
        pathRules: { paths: ['future/missing.md'] }
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
        pathRules: { paths: ['future/missing.md'] }
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
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([{ glob: 'outputs/**/*.png' }], ['outputs/**/high/*.png']));
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
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['outputs/gpt/'], ['outputs/gpt/[bd].png']));
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
      await writeFile(join(projectRoot, 'image-production/generated/large-still.png'), await largePreviewablePngBuffer());
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
        { glob: 'image-production/generated/*.png' },
        { glob: 'image-production/generated/*.gif' }
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
        mediaKind: 'unknown',
        availability: { state: 'available', mimeType: 'text/plain' }
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
      await writeFile(join(projectRoot, 'image-production/generated/broken.png'), Buffer.alloc(1600000, 1));
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([{ glob: 'image-production/generated/*.png' }]));
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
      await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([{ glob: 'image-production/generated/*.png' }]));
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
        nodeElements: (server.getSnapshot().canvases[0]?.nodeElements ?? []).map((node) => (node.projectRelativePath === 'prompts/cover.md'
          ? { ...node, x: 321, y: 654, layoutMode: 'manual' }
          : node))
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
        project: {
          id: 'project-empty-canvas',
          name: 'Empty Canvas',
          createdAt: '2026-05-23T10:30:00.000Z',
          updatedAt: '2026-05-23T10:30:00.000Z'
        }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), JSON.stringify({
        id: 'canvas-1',
        name: 'canvas-1',
        nodeElements: [],
        annotations: [],
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), 'paths: []\n', 'utf8');
      await writeFile(join(projectRoot, '.debrute/canvases/index.json'), JSON.stringify({
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
  const gzipBuffer = promisify(gzip);
  describe('DebruteAppServer Canvas display names', () => {
    it('renames a Canvas display name without moving id-keyed files', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-name-'));
      const server = new DebruteAppServer();
      try {
        await server.openProject(projectRoot, {
          initializeIfMissing: true,
          createDefaultCanvas: true,
          watchFiles: false
        });

        const result = await server.renameCanvas({
          canvasId: 'canvas-1',
          name: '  故事板  '
        });

        expect(result.activeCanvasId).toBe('canvas-1');
        expect(result.snapshot.canvasRegistry).toEqual({
          status: 'ready',
          canvasOrder: ['canvas-1']
        });
        expect(result.snapshot.canvases[0]).toMatchObject({
          id: 'canvas-1',
          name: '故事板'
        });
        expect(JSON.parse(await readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8'))).toMatchObject({
          id: 'canvas-1',
          name: '故事板'
        });
        expect(JSON.parse(await readFile(join(projectRoot, '.debrute/canvases/index.json'), 'utf8'))).toEqual({
          canvasOrder: ['canvas-1']
        });
        await expect(stat(join(projectRoot, '.debrute/canvases/故事板.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'))).resolves.toBeTruthy();
        await expect(stat(join(projectRoot, '.debrute/canvas-maps/故事板.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        server.close();
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('keeps text preview sources readable after a Canvas display name change', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-name-preview-'));
      const server = new DebruteAppServer();
      const sourceUpload = join(projectRoot, 'upload.png');
      try {
        await server.openProject(projectRoot, {
          initializeIfMissing: true,
          createDefaultCanvas: true,
          watchFiles: false
        });
        await sharp({
          create: {
            width: 120,
            height: 60,
            channels: 4,
            background: { r: 20, g: 20, b: 20, alpha: 1 }
          }
        }).png().toFile(sourceUpload);
        const target = {
          canvasId: 'canvas-1',
          projectRelativePath: 'notes/scene.md',
          fingerprint: 'fingerprint-a'
        };
        await server.saveCanvasTextPreviewSource({
          ...target,
          sourceTemporaryPath: sourceUpload
        });
        const sourcePath = join(projectRoot, canvasTextPreviewSourceProjectPath(target));

        await server.renameCanvas({
          canvasId: 'canvas-1',
          name: '故事板'
        });
        const sources = await server.readCanvasTextPreviewSources({
          canvasId: 'canvas-1',
          sources: [{
            projectRelativePath: target.projectRelativePath,
            fingerprint: target.fingerprint
          }]
        });

        expect(sources.sources['notes/scene.md']).toEqual({
          projectRelativePath: 'notes/scene.md',
          fingerprint: 'fingerprint-a',
          status: 'available'
        });
        await expect(stat(sourcePath)).resolves.toBeTruthy();
      } finally {
        server.close();
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe('DebruteAppServer Canvas video playback state', { tags: ['canvas-video'] }, () => {
    it('persists video playback time in the Canvas document', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-playback-state-'));
      const server = new DebruteAppServer({
        canvasNodeLayoutSizeReader: async () => ({ width: 640, height: 360 })
      });
      try {
        await server.openProject(projectRoot, {
          initializeIfMissing: true,
          createDefaultCanvas: true,
          watchFiles: false
        });
        await mkdir(join(projectRoot, 'media'), { recursive: true });
        await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-bytes', 'utf8');
        const canvasPath = join(projectRoot, '.debrute/canvases/canvas-1.json');
        await server.addProjectPathToCanvasMap({
          canvasId: 'canvas-1',
          projectRelativePath: 'media/clip.mp4'
        });

        const result = await server.updateCanvasVideoPlaybackState({
          canvasId: 'canvas-1',
          updates: [{ projectRelativePath: 'media/clip.mp4', currentTimeSeconds: 9.25 }]
        });

        expect(result.canvas.nodeElements.find((node) => node.projectRelativePath === 'media/clip.mp4')).toMatchObject({
          projectRelativePath: 'media/clip.mp4',
          videoPlayback: { currentTimeSeconds: 9.25 }
        });
        const savedCanvas = JSON.parse(await readFile(canvasPath, 'utf8')) as {
          nodeElements: Array<{ projectRelativePath: string; videoPlayback?: { currentTimeSeconds: number } }>;
        };
        expect(savedCanvas.nodeElements.find((node) => node.projectRelativePath === 'media/clip.mp4')).toMatchObject({
          projectRelativePath: 'media/clip.mp4',
          videoPlayback: { currentTimeSeconds: 9.25 }
        });
      } finally {
        server.close();
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe('DebruteAppServer Canvas text viewport state', { tags: ['canvas-text'] }, () => {
    it('persists text viewport in the Canvas document', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-viewport-state-'));
      const server = new DebruteAppServer({
        canvasNodeLayoutSizeReader: async () => ({ width: 420, height: 260 })
      });
      try {
        await server.openProject(projectRoot, {
          initializeIfMissing: true,
          createDefaultCanvas: true,
          watchFiles: false
        });
        await mkdir(join(projectRoot, 'notes'), { recursive: true });
        await writeFile(join(projectRoot, 'notes/readme.md'), '# Notes', 'utf8');
        const canvasPath = join(projectRoot, '.debrute/canvases/canvas-1.json');
        await server.addProjectPathToCanvasMap({
          canvasId: 'canvas-1',
          projectRelativePath: 'notes/readme.md'
        });

        const result = await server.updateCanvasTextViewportState({
          canvasId: 'canvas-1',
          updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
        });

        expect(result.canvas.nodeElements.find((node) => node.projectRelativePath === 'notes/readme.md')).toMatchObject({
          projectRelativePath: 'notes/readme.md',
          textViewport: { scrollTop: 72, scrollLeft: 9 }
        });
        const savedCanvas = JSON.parse(await readFile(canvasPath, 'utf8')) as {
          nodeElements: Array<{ projectRelativePath: string; textViewport?: { scrollTop: number; scrollLeft: number } }>;
        };
        expect(savedCanvas.nodeElements.find((node) => node.projectRelativePath === 'notes/readme.md')).toMatchObject({
          projectRelativePath: 'notes/readme.md',
          textViewport: { scrollTop: 72, scrollLeft: 9 }
        });
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

  function canvasMapSource(paths: Array<string | {
    glob: string;
  }>, layoutRows: string[] = []): string {
    return [
      'paths:',
      ...paths.map((path) => typeof path === 'string' ? `  - ${path}` : `  - glob: ${path.glob}`),
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
      id,
      name: id,
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

  function canvasNodeRectsOverlap(left: {
    x: number;
    y: number;
    width: number;
    height: number;
  }, right: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): boolean {
    return left.x < right.x + right.width
      && left.x + left.width > right.x
      && left.y < right.y + right.height
      && left.y + left.height > right.y;
  }

  function projectMetadata(name: string) {
    return {
      project: {
        id: `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-id`,
        name,
        createdAt: '2026-06-27T00:00:00.000Z',
        updatedAt: '2026-06-27T00:00:00.000Z'
      }
    };
  }

  function canvasLayoutSizeReader(sizes: Record<string, {
    width: number;
    height: number;
  }>) {
    return async (input: {
      projectRelativePath: string;
      nodeKind: string;
      mediaKind: string;
    }) => {
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
});
