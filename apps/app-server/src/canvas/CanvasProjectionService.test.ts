import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCanvasDocument, type CanvasProjection } from '@debrute/canvas-core';
import {
  assertCurrentCanvasDocument,
  canvasMediaKindFromPath,
  CanvasProjectionService
} from './CanvasProjectionService';

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
