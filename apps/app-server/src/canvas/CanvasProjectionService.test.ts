import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCanvasDocument, type CanvasProjection } from '@debrute/canvas-core';
import {
  assertCurrentCanvasDocument,
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

  it('projects available video nodes with video presentation companions', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-projection-'));
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video', 'utf8');
      await writeFile(join(projectRoot, 'media/clip.poster.png'), 'poster', 'utf8');
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
        lookupGeneratedAssetMetadata: async () => ({
          status: 'unmatched',
          fingerprint: { algorithm: 'sha256', hash: 'none' }
        }),
        listGeneratedAssetsByModelRun: async () => [],
        findCurrentProjectPathForGeneratedAsset: async () => undefined,
        readCanvasVideoMetadata: async () => ({ width: 640, height: 360, durationSeconds: 5 })
      });
      const projection = await projectionService.projectCanvasDocument(projectRoot, canvas);

      expect(projection.nodes[0]).toMatchObject({
        mediaKind: 'video',
        videoPresentation: {
          kind: 'video',
          durationSeconds: 5,
          poster: {
            projectRelativePath: 'media/clip.poster.png',
            source: 'explicit'
          },
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
      expect(projection.nodes[0]?.videoPresentation?.poster).not.toHaveProperty('fileUrl');
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
      lookupGeneratedAssetMetadata: async () => ({
        status: 'unmatched',
        fingerprint: { algorithm: 'sha256', hash: 'none' }
      }),
      listGeneratedAssetsByModelRun: async () => [],
      findCurrentProjectPathForGeneratedAsset: async () => undefined,
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
});
