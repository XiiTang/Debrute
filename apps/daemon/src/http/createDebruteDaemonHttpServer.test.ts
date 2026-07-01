import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { projectFileRevision } from '@debrute/project-core';
import { createDebruteDaemonHttpServer } from './createDebruteDaemonHttpServer.js';
import type {
  CanvasVideoPreviewSourceResponse,
  DebruteHttpErrorBody,
  WorkbenchProjectOpenResult
} from '@debrute/app-protocol';

describe('createDebruteDaemonHttpServer Canvas text preview routes', () => {
  it('returns source-missing and invalid-input errors from the text preview image endpoint', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-text-preview-'));
    const server = createDebruteDaemonHttpServer({
      port: 0,
      token: 'test-token',
      adobeBridgeDiscoveryPort: 0
    });
    try {
      const runtime = await server.listen();
      const open = await fetch(`${runtime.daemonUrl}/api/projects/open`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': server.token
        },
        body: JSON.stringify({ projectRoot })
      });
      expect(open.status).toBe(200);
      const project = await open.json() as WorkbenchProjectOpenResult;

      const missing = await fetch(`${runtime.daemonUrl}/api/projects/${project.projectId}/canvas-text-preview?canvasId=canvas-1&path=notes%2Fmissing.md&fingerprint=fingerprint-missing&w=80`, {
        headers: { 'x-debrute-daemon-token': server.token }
      });
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toMatchObject({
        error: {
          code: 'canvas_text_preview_source_missing',
          message: 'Canvas text preview source is not available: notes/missing.md'
        }
      } satisfies Partial<DebruteHttpErrorBody>);

      const invalidWidth = await fetch(`${runtime.daemonUrl}/api/projects/${project.projectId}/canvas-text-preview?canvasId=canvas-1&path=notes%2Fmissing.md&fingerprint=fingerprint-missing&w=0`, {
        headers: { 'x-debrute-daemon-token': server.token }
      });
      expect(invalidWidth.status).toBe(400);
      await expect(invalidWidth.json()).resolves.toMatchObject({
        error: {
          code: 'invalid_input',
          message: 'w must be a positive integer.'
        }
      } satisfies Partial<DebruteHttpErrorBody>);
    } finally {
      await server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('createDebruteDaemonHttpServer Canvas video playback route', () => {
  it('updates persisted Canvas video playback time', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-video-playback-'));
    const server = createDebruteDaemonHttpServer({
      port: 0,
      token: 'test-token',
      adobeBridgeDiscoveryPort: 0,
      appServerOptions: {
        canvasNodeLayoutSizeReader: async () => ({ width: 640, height: 360 })
      }
    });
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-bytes', 'utf8');
      const runtime = await server.listen();
      const open = await fetch(`${runtime.daemonUrl}/api/projects/open`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': server.token
        },
        body: JSON.stringify({ projectRoot })
      });
      expect(open.status).toBe(200);
      const project = await open.json() as WorkbenchProjectOpenResult;

      const add = await fetch(`${runtime.daemonUrl}/api/projects/${project.projectId}/canvases/canvas-1/canvas-map/project-paths`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': server.token
        },
        body: JSON.stringify({
          baseRevision: project.projectRevision,
          projectRelativePath: 'media/clip.mp4'
        })
      });
      expect(add.status).toBe(200);
      const addResult = await add.json() as { projectRevision: number };

      const response = await fetch(`${runtime.daemonUrl}/api/projects/${project.projectId}/canvases/canvas-1/video-playback`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': server.token
        },
        body: JSON.stringify({
          baseRevision: addResult.projectRevision,
          updates: [{ projectRelativePath: 'media/clip.mp4', currentTimeSeconds: 7.5 }]
        })
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        canvas: {
          nodeElements: expect.arrayContaining([
            expect.objectContaining({
              projectRelativePath: 'media/clip.mp4',
              videoPlayback: { currentTimeSeconds: 7.5 }
            })
          ])
        },
        projection: {
          canvasId: 'canvas-1'
        }
      });
    } finally {
      await server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('createDebruteDaemonHttpServer Canvas video preview routes', () => {
  it('creates an explicit poster source and serves a cached preview variant', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-video-preview-'));
    const server = createDebruteDaemonHttpServer({
      port: 0,
      token: 'test-token',
      adobeBridgeDiscoveryPort: 0
    });
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-bytes', 'utf8');
      await sharp({
        create: {
          width: 320,
          height: 180,
          channels: 3,
          background: { r: 80, g: 40, b: 120 }
        }
      }).jpeg().toFile(join(projectRoot, 'media/clip.jpg'));
      const videoStat = await stat(join(projectRoot, 'media/clip.mp4'));
      const videoRevision = projectFileRevision(videoStat.size, videoStat.mtimeMs);
      const runtime = await server.listen();
      const open = await fetch(`${runtime.daemonUrl}/api/projects/open`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': server.token
        },
        body: JSON.stringify({ projectRoot })
      });
      expect(open.status).toBe(200);
      const project = await open.json() as WorkbenchProjectOpenResult;

      const sourcesResponse = await fetch(`${runtime.daemonUrl}/api/projects/${project.projectId}/canvas-video-previews/sources`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': server.token
        },
        body: JSON.stringify({
          canvasId: 'canvas-1',
          targets: [{
            projectRelativePath: 'media/clip.mp4',
            videoRevision,
            currentTimeSeconds: 0
          }]
        })
      });
      expect(sourcesResponse.status).toBe(200);
      const sources = await sourcesResponse.json() as CanvasVideoPreviewSourceResponse;
      const source = sources.sources['media/clip.mp4'];
      expect(source).toMatchObject({
        status: 'available',
        sourceKind: 'initial-poster',
        sourceWidth: 320
      });
      if (!source || source.status !== 'available') {
        throw new Error('Expected available source.');
      }

      const imageUrl = new URL(`${runtime.daemonUrl}/api/projects/${project.projectId}/canvas-video-preview`);
      imageUrl.searchParams.set('canvasId', 'canvas-1');
      imageUrl.searchParams.set('path', 'media/clip.mp4');
      imageUrl.searchParams.set('videoRevision', videoRevision);
      imageUrl.searchParams.set('t', '0');
      imageUrl.searchParams.set('sourceKey', source.sourceKey);
      imageUrl.searchParams.set('w', '80');
      const image = await fetch(imageUrl, {
        headers: { 'x-debrute-daemon-token': server.token }
      });

      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toContain('image/jpeg');
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0);
    } finally {
      await server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
