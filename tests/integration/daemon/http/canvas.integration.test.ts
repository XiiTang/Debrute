import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DebruteAppServer } from '@debrute/app-server';
import type {
  CanvasVideoPreviewSourceResponse,
  DebruteHttpErrorBody,
  WorkbenchCanvasDocumentMutationResult
} from '@debrute/app-protocol';
import { projectFileRevision } from '@debrute/project-core';
import sharp from 'sharp';
import {
  createDaemonProjectSnapshotFixture,
  DaemonTestHarness,
  readDaemonSseEvent
} from '../../../helpers/daemonTestHarness.js';

describe('daemon Canvas HTTP routes', () => {
  it('does not expose Canvas settings HTTP routes', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;

    const [aggregateResponse, getResponse, putResponse] = await Promise.all([
      fetch(`${runtime.daemonUrl}/api/settings/global`, {
        headers: { 'x-debrute-daemon-token': harness.token }
      }),
      fetch(`${runtime.daemonUrl}/api/settings/canvas`, {
        headers: { 'x-debrute-daemon-token': harness.token }
      }),
      fetch(`${runtime.daemonUrl}/api/settings/canvas`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': harness.token
        },
        body: JSON.stringify({})
      })
    ]);
    const aggregate = await aggregateResponse.json() as Record<string, unknown>;
    await getResponse.text();
    await putResponse.text();

    expect(aggregateResponse.status).toBe(200);
    expect(aggregate).not.toHaveProperty('canvas');
    expect(aggregate).toHaveProperty('models.audio');
    expect(getResponse.status).toBe(404);
    expect(putResponse.status).toBe(404);
  });

  it('aborts queued canvas preview work when the client closes the request', async () => {
    const aborts: string[] = [];
    const previewEntered = deferredBarrier();
    const abortObserved = deferredBarrier();
    const releaseResponse = deferredBarrier();
    const appServer = {
      openProject: async (root: string) => createDaemonProjectSnapshotFixture(root),
      currentSnapshot: () => undefined,
      onEvent: () => () => undefined,
      close: () => undefined,
      resolveCanvasImagePreview: async (input: { abortSignal?: AbortSignal }) => {
        input.abortSignal?.addEventListener('abort', () => {
          aborts.push('aborted');
          abortObserved.resolve();
        }, { once: true });
        previewEntered.resolve();
        await releaseResponse.promise;
        throw new Error('preview should have been aborted before completion');
      }
    } as unknown as DebruteAppServer;
    await using harness = await DaemonTestHarness.create({
      createAppServer: () => appServer
    });
    const runtime = harness.runtime;
    const project = await harness.createProject();
    await harness.openProject(project);
    const abortController = new AbortController();
    const request = fetch(
      `${runtime.daemonUrl}/api/projects/${project.projectId}/canvas-image-preview?path=flow%2Fa.png&v=1&w=256`,
      {
        headers: { 'x-debrute-daemon-token': harness.token },
        signal: abortController.signal
      }
    ).catch((error) => error);

    try {
      await waitForBarrier(previewEntered.promise, 'Canvas preview resolver entry');
      abortController.abort();
      await waitForBarrier(abortObserved.promise, 'Canvas preview request abort');
    } finally {
      releaseResponse.resolve();
    }
    await request;

    expect(aborts).toEqual(['aborted']);
  });

  it('does not abort normal slow canvas preview requests before the response finishes', async () => {
    const aborts: string[] = [];
    const previewEntered = deferredBarrier();
    const releaseResponse = deferredBarrier();
    let previewPath = '';
    const appServer = {
      openProject: async (root: string) => createDaemonProjectSnapshotFixture(root),
      currentSnapshot: () => undefined,
      onEvent: () => () => undefined,
      close: () => undefined,
      resolveCanvasImagePreview: async (input: { abortSignal?: AbortSignal }) => {
        input.abortSignal?.addEventListener('abort', () => aborts.push('aborted'), { once: true });
        previewEntered.resolve();
        await releaseResponse.promise;
        return { absolutePath: previewPath };
      }
    } as unknown as DebruteAppServer;
    await using harness = await DaemonTestHarness.create({
      createAppServer: () => appServer
    });
    const runtime = harness.runtime;
    const project = await harness.createProject({ 'preview.png': 'preview' });
    previewPath = join(project.rootPath, 'preview.png');
    await harness.openProject(project);

    const request = fetch(`${runtime.daemonUrl}/api/projects/${project.projectId}/canvas-image-preview?path=flow%2Fa.png&v=1&w=256`, {
      headers: { 'x-debrute-daemon-token': harness.token }
    });
    try {
      await waitForBarrier(previewEntered.promise, 'Canvas preview resolver entry');
      expect(aborts).toEqual([]);
    } finally {
      releaseResponse.resolve();
    }
    const response = await request;

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('preview');
    expect(aborts).toEqual([]);
  });

  it('streams canvas changed events with browser file URLs', async () => {
    let appServer: DebruteAppServer | undefined;
    await using harness = await DaemonTestHarness.create({
      createAppServer: () => {
        appServer = new DebruteAppServer();
        return appServer;
      }
    });
    const runtime = harness.runtime;
    const project = await harness.createProject();
    const projectRoot = project.rootPath;
    await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
    await sharp({
      create: {
        width: 16,
        height: 12,
        channels: 4,
        background: '#336699ff'
      }
    }).png().toFile(join(projectRoot, 'image-production/generated/cover.png'));
    await harness.openProject(project);
    const opened = { projectId: project.projectId };
    await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([{ glob: 'image-production/generated/*.png' }]));
    if (!appServer) {
      throw new Error('Daemon did not create a project app server.');
    }
    await appServer.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
    const refreshed = await harness.fetchOkJson<{
      projectRevision: number;
      snapshot: {
        projections: Array<{ nodes: Array<{ projectRelativePath: string; x: number; y: number; availability: { state: string; fileUrl?: string } }> }>;
      };
    }>(`/api/projects/${opened.projectId}/refresh`, {
      method: 'POST'
    });
    const node = refreshed.snapshot.projections[0]!.nodes.find((item) => item.projectRelativePath === 'image-production/generated/cover.png')!;
    expect(node.availability.fileUrl).toContain(`/api/projects/${opened.projectId}/files/raw/image-production/generated/cover.png`);
    if (!node.availability.fileUrl) {
      throw new Error('Canvas node did not include a browser file URL.');
    }
    const rawFileResponse = await fetch(new URL(node.availability.fileUrl, runtime.daemonUrl), {
      headers: { 'x-debrute-daemon-token': harness.token }
    });
    expect(rawFileResponse.status).toBe(200);
    expect(rawFileResponse.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(rawFileResponse.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await rawFileResponse.arrayBuffer()).length).toBeGreaterThan(0);

    const response = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events`, {
      headers: { 'x-debrute-daemon-token': harness.token }
    });
    await harness.fetchOkJson(`/api/projects/${opened.projectId}/canvases/canvas-1/node-layouts`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        baseRevision: refreshed.projectRevision,
        nodeLayouts: [{ projectRelativePath: node.projectRelativePath, x: node.x + 10, y: node.y }]
      })
    });

    const event = await readDaemonSseEvent<{
      type: string;
      projection: { nodes: Array<{ projectRelativePath: string; availability: { state: string; fileUrl?: string } }> };
    }>(response);
    const eventNode = event.projection.nodes.find((item) => item.projectRelativePath === node.projectRelativePath)!;

    expect(event.type).toBe('canvas.changed');
    expect(eventNode.availability.fileUrl).toBe(node.availability.fileUrl);
  });

  it('serves video text track companions with browser file URLs at the HTTP snapshot boundary', async () => {
    await using harness = await DaemonTestHarness.create({
      appServerOptions: {
        canvasVideoMetadataReader: async () => ({
          width: 640,
          height: 360,
          durationSeconds: 5
        })
      }
    });
    const project = await harness.createProject({
      'media/clip.mp4': 'video-bytes',
      'media/clip.poster.webp': 'poster-bytes',
      'media/clip.en.vtt': 'WEBVTT\n',
      '.debrute/project.json': JSON.stringify(projectMetadata('Video Presentation URLs'), null, 2),
      '.debrute/canvases/index.json': JSON.stringify({ canvasOrder: ['canvas-1'] }, null, 2),
      '.debrute/canvases/canvas-1.json': JSON.stringify({
        id: 'canvas-1',
        name: 'canvas-1',
        nodeElements: [{
          projectRelativePath: 'media/clip.mp4',
          nodeKind: 'file',
          mediaKind: 'video',
          x: 0,
          y: 0,
          width: 640,
          height: 360,
          z: 0
        }],
        annotations: [],
        preferences: { showDiagnostics: true }
      }, null, 2),
      '.debrute/canvas-maps/canvas-1.yaml': canvasMapSource(['media/clip.mp4'])
    });
    await harness.openProject(project);
    const opened = { projectId: project.projectId };

    const refreshed = await harness.fetchOkJson<{
      snapshot: {
        projections: Array<{
          nodes: Array<{
            projectRelativePath: string;
            availability: { state: string; fileUrl?: string };
            videoPresentation?: Record<string, unknown> & {
              textTracks: Array<{ projectRelativePath: string; fileUrl?: string }>;
            };
          }>;
        }>;
      };
    }>(`/api/projects/${opened.projectId}/refresh`, {
      method: 'POST'
    });

    const node = refreshed.snapshot.projections[0]!.nodes.find((item) => item.projectRelativePath === 'media/clip.mp4')!;
    expect(node.availability.fileUrl).toContain(`/api/projects/${opened.projectId}/files/raw/media/clip.mp4`);
    expect(node.videoPresentation).not.toHaveProperty('poster');
    expect(node.videoPresentation?.textTracks[0]?.fileUrl).toContain(`/api/projects/${opened.projectId}/files/raw/media/clip.en.vtt`);
  });

  it('resets manual Canvas layout through the HTTP Canvas route', async () => {
    let appServer: DebruteAppServer | undefined;
    await using harness = await DaemonTestHarness.create({
      createAppServer: () => {
        appServer = new DebruteAppServer();
        return appServer;
      }
    });
    const project = await harness.createProject({
      'prompts/cover.md': '# Cover\n',
      'outputs/gpt/a.md': '# A\n'
    });
    const projectRoot = project.rootPath;
    await harness.openProject(project);
    const opened = { projectId: project.projectId };
    await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['prompts/cover.md', { glob: 'outputs/**/*.md' }]));
    if (!appServer) {
      throw new Error('Daemon did not create a project app server.');
    }
    await appServer.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
    const refreshed = await harness.fetchOkJson<{ projectRevision: number }>(`/api/projects/${opened.projectId}/refresh`, {
      method: 'POST'
    });
    const layout = await harness.fetchOkJson<{ projectRevision: number }>(`/api/projects/${opened.projectId}/canvases/canvas-1/node-layouts`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        baseRevision: refreshed.projectRevision,
        nodeLayouts: [
          { projectRelativePath: 'prompts/cover.md', x: 1000, y: 900 },
          { projectRelativePath: 'outputs/gpt/a.md', x: 1200, y: 950 }
        ]
      })
    });

    const partialReset = await harness.fetchOkJson<{
      projectRevision: number;
      resetCount: number;
      canvas: { nodeElements: Array<{ projectRelativePath: string; layoutMode?: string }> };
      projection: { nodes: Array<{ projectRelativePath: string }> };
    }>(`/api/projects/${opened.projectId}/canvases/canvas-1/reset-layout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        baseRevision: layout.projectRevision,
        pathRules: { globs: ['outputs/**/*.md'] }
      })
    });

    expect(partialReset.resetCount).toBe(1);
    expect(partialReset.canvas.nodeElements.find((node) => node.projectRelativePath === 'outputs/gpt/a.md')).not.toHaveProperty('layoutMode');
    expect(partialReset.canvas.nodeElements.find((node) => node.projectRelativePath === 'prompts/cover.md')).toHaveProperty('layoutMode', 'manual');

    const allReset = await harness.fetchOkJson<{
      resetCount: number;
      canvas: { nodeElements: Array<{ projectRelativePath: string; layoutMode?: string }> };
      projection: { nodes: Array<{ projectRelativePath: string }> };
    }>(`/api/projects/${opened.projectId}/canvases/canvas-1/reset-layout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        baseRevision: partialReset.projectRevision,
        all: true
      })
    });

    expect(allReset.resetCount).toBe(1);
    expect(allReset.canvas.nodeElements.find((node) => node.projectRelativePath === 'prompts/cover.md')).not.toHaveProperty('layoutMode');
    expect(allReset.projection.nodes.map((node) => node.projectRelativePath)).toContain('prompts/cover.md');
  });

  it('adds project tree paths to Canvas Maps through the HTTP Canvas route', async () => {
    let appServer: DebruteAppServer | undefined;
    await using harness = await DaemonTestHarness.create({
      createAppServer: () => {
        appServer = new DebruteAppServer();
        return appServer;
      }
    });
    const runtime = harness.runtime;
    const project = await harness.createProject({
      'prompts/cover.md': '# Cover\n',
      'prompts/alt.md': '# Alt\n',
      'prompts/conflict.md': '# Conflict\n'
    });
    const projectRoot = project.rootPath;
    await harness.openProject(project);
    const opened = { projectId: project.projectId };
    await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['prompts/cover.md']));
    if (!appServer) {
      throw new Error('Daemon did not create a project app server.');
    }
    await appServer.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
    const currentProject = await harness.fetchOkJson<{ projectRevision: number }>(`/api/projects/${opened.projectId}`);

    const result = await harness.fetchOkJson<{
      projectRevision: number;
      snapshot: { canvases: Array<{ id: string; nodeElements: Array<{ projectRelativePath: string }> }> };
      projection: { nodes: Array<{ projectRelativePath: string }> };
      centerProjectRelativePath: string;
    }>(`/api/projects/${opened.projectId}/canvases/canvas-1/canvas-map/project-paths`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        baseRevision: currentProject.projectRevision,
        projectRelativePath: 'prompts/alt.md'
      })
    });

    expect(result.centerProjectRelativePath).toBe('prompts/alt.md');
    expect(result.snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual(expect.arrayContaining([
      'prompts',
      'prompts/cover.md',
      'prompts/alt.md'
    ]));
    expect(result.projection.nodes.map((node) => node.projectRelativePath)).toContain('prompts/alt.md');
    await expect(readFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), 'utf8')).resolves.toBe(canvasMapSource([
      'prompts/cover.md',
      'prompts/alt.md'
    ]));

    await writeFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), canvasMapSource([
      'prompts/cover.md',
      'external/edit.md'
    ]), 'utf8');
    const conflict = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/canvas-1/canvas-map/project-paths`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': harness.token
      },
      body: JSON.stringify({
        baseRevision: result.projectRevision,
        projectRelativePath: 'prompts/conflict.md'
      })
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'canvas_map_conflict' }
    });
  });

  it('manages canvases through project-scoped HTTP routes', async () => {
    await using harness = await DaemonTestHarness.create();
    const project = await harness.createProject();
    const projectRoot = project.rootPath;
    const opened = await harness.fetchOkJson<{ projectId: string; projectRevision: number }>('/api/projects/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot })
    });

    const created = await harness.fetchOkJson<{ projectRevision: number; activeCanvasId: string; snapshot: { canvasRegistry: { status: string; canvasOrder: string[] } } }>(
      `/api/projects/${opened.projectId}/canvases`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision: opened.projectRevision })
      }
    );
    expect(created.activeCanvasId).toBe('canvas-2');
    expect(created.snapshot.canvasRegistry).toEqual({ status: 'ready', canvasOrder: ['canvas-1', 'canvas-2'] });

    const renamed = await harness.fetchOkJson<{ projectRevision: number; activeCanvasId: string; snapshot: { canvasRegistry: { status: string; canvasOrder: string[] } } }>(
      `/api/projects/${opened.projectId}/canvases/canvas-2`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ baseRevision: created.projectRevision, operation: 'rename', name: 'Storyboard' })
      }
    );
    expect(renamed.activeCanvasId).toBe('canvas-2');
    expect(renamed.snapshot.canvasRegistry).toEqual({ status: 'ready', canvasOrder: ['canvas-1', 'canvas-2'] });

    const reordered = await harness.fetchOkJson<{ projectRevision: number; snapshot: { canvasRegistry: { status: string; canvasOrder: string[] } } }>(
      `/api/projects/${opened.projectId}/canvases/index`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ baseRevision: renamed.projectRevision, canvasOrder: ['canvas-2', 'canvas-1'] })
      }
    );
    expect(reordered.snapshot.canvasRegistry).toEqual({ status: 'ready', canvasOrder: ['canvas-2', 'canvas-1'] });

    const deleted = await harness.fetchOkJson<{ projectRevision: number; activeCanvasId: string; snapshot: { canvasRegistry: { status: string; canvasOrder: string[] } } }>(
      `/api/projects/${opened.projectId}/canvases/canvas-2`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision: reordered.projectRevision })
      }
    );
    expect(deleted.activeCanvasId).toBe('canvas-1');
    expect(deleted.snapshot.canvasRegistry).toEqual({ status: 'ready', canvasOrder: ['canvas-1'] });

    await rm(join(projectRoot, '.debrute/canvases/index.json'));
    const repaired = await harness.fetchOkJson<{ activeCanvasId: string; snapshot: { canvasRegistry: { status: string; canvasOrder: string[] } } }>(
      `/api/projects/${opened.projectId}/canvases/index/repair`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision: deleted.projectRevision })
      }
    );
    expect(repaired.activeCanvasId).toBe('canvas-1');
    expect(repaired.snapshot.canvasRegistry).toEqual({ status: 'ready', canvasOrder: ['canvas-1'] });
    await expect(readFile(join(projectRoot, '.debrute/canvases/index.json'), 'utf8')).resolves.toContain('"canvas-1"');
  });

  describe('Canvas text preview routes', { tags: ['canvas-text'] }, () => {
    it('returns source-missing and invalid-input errors from the text preview image endpoint', async () => {
      await using harness = await DaemonTestHarness.create();
      const project = await harness.createProject();
      await harness.openProject(project);

      const missing = await harness.fetchJson<DebruteHttpErrorBody>(
        `/api/projects/${project.projectId}/canvas-text-preview?canvasId=canvas-1&path=notes%2Fmissing.md&fingerprint=fingerprint-missing&w=80`
      );
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({
        error: {
          code: 'canvas_text_preview_source_missing',
          message: 'Canvas text preview source is not available: notes/missing.md'
        }
      } satisfies Partial<DebruteHttpErrorBody>);

      const invalidWidth = await harness.fetchJson<DebruteHttpErrorBody>(
        `/api/projects/${project.projectId}/canvas-text-preview?canvasId=canvas-1&path=notes%2Fmissing.md&fingerprint=fingerprint-missing&w=0`
      );
      expect(invalidWidth.status).toBe(400);
      expect(invalidWidth.body).toMatchObject({
        error: {
          code: 'invalid_input',
          message: 'w must be a positive integer.'
        }
      } satisfies Partial<DebruteHttpErrorBody>);
    });

    it('requires project-scoped text preview source uploads to use POST', async () => {
      await using harness = await DaemonTestHarness.create();
      const project = await harness.createProject();
      await harness.openProject(project);

      const response = await harness.fetchJson<DebruteHttpErrorBody>(
        `/api/projects/${project.projectId}/canvas-text-previews/source`
      );

      expect(response.status).toBe(405);
      expect(response.body).toMatchObject({
        error: { code: 'method_not_allowed' }
      });
    });

    it('requires project-scoped text preview source availability reads to use POST', async () => {
      await using harness = await DaemonTestHarness.create();
      const project = await harness.createProject();
      await harness.openProject(project);

      const response = await harness.fetchJson<DebruteHttpErrorBody>(
        `/api/projects/${project.projectId}/canvas-text-previews/sources`
      );

      expect(response.status).toBe(405);
      expect(response.body).toMatchObject({
        error: { code: 'method_not_allowed' }
      });
    });
  });

  describe('Canvas video playback route', { tags: ['canvas-video'] }, () => {
    it('updates persisted Canvas video playback time', async () => {
      await using harness = await DaemonTestHarness.create({
        appServerOptions: {
          canvasNodeLayoutSizeReader: async () => ({ width: 640, height: 360 })
        }
      });
      const project = await harness.createProject({
        'media/clip.mp4': 'video-bytes'
      });
      const opened = await harness.fetchOkJson<{ projectId: string; projectRevision: number }>('/api/projects/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectRoot: project.rootPath })
      });

      const add = await harness.fetchOkJson<{ projectRevision: number }>(
        `/api/projects/${opened.projectId}/canvases/canvas-1/canvas-map/project-paths`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseRevision: opened.projectRevision,
            projectRelativePath: 'media/clip.mp4'
          })
        }
      );

      const response = await harness.fetchJson<WorkbenchCanvasDocumentMutationResult>(
        `/api/projects/${opened.projectId}/canvases/canvas-1/video-playback`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseRevision: add.projectRevision,
            updates: [{ projectRelativePath: 'media/clip.mp4', currentTimeSeconds: 7.5 }]
          })
        }
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
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
    });
  });

  describe('Canvas text viewport route', { tags: ['canvas-text'] }, () => {
    it('rejects stale text viewport mutations', async () => {
      await using harness = await DaemonTestHarness.create();
      const project = await harness.createProject();
      const opened = await harness.fetchOkJson<{ projectId: string; projectRevision: number }>('/api/projects/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectRoot: project.rootPath })
      });

      await harness.fetchOkJson(`/api/projects/${opened.projectId}/canvases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision: opened.projectRevision })
      });

      const stale = await harness.fetchJson<DebruteHttpErrorBody>(
        `/api/projects/${opened.projectId}/canvases/canvas-1/text-viewport`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseRevision: opened.projectRevision,
            updates: [{ projectRelativePath: 'notes/a.md', scrollTop: 20, scrollLeft: 4 }]
          })
        }
      );

      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({
        error: {
          code: 'stale_project_revision'
        }
      } satisfies Partial<DebruteHttpErrorBody>);
    });
  });

  describe('Canvas stack-order route', () => {
    it('returns invalid-input when bring-to-front projectRelativePath is not a string', async () => {
      await using harness = await DaemonTestHarness.create();
      const project = await harness.createProject();
      const opened = await harness.fetchOkJson<{ projectId: string; projectRevision: number }>('/api/projects/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectRoot: project.rootPath })
      });

      const response = await harness.fetchJson<DebruteHttpErrorBody>(
        `/api/projects/${opened.projectId}/canvases/canvas-1/node-stack-order/bring-to-front`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseRevision: opened.projectRevision,
            projectRelativePath: 12
          })
        }
      );

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: {
          code: 'invalid_input',
          message: 'projectRelativePath must be a string.'
        }
      } satisfies Partial<DebruteHttpErrorBody>);
    });

    it('brings a Canvas node to the top through the stack-order route', async () => {
      await using harness = await DaemonTestHarness.create({
        appServerOptions: {
          canvasNodeLayoutSizeReader: async () => ({ width: 120, height: 80 })
        }
      });
      const project = await harness.createProject({
        'flow/a.png': 'a',
        'flow/b.png': 'b'
      });
      const opened = await harness.fetchOkJson<{ projectId: string; projectRevision: number }>('/api/projects/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectRoot: project.rootPath })
      });

      const addA = await harness.fetchOkJson<{ projectRevision: number }>(
        `/api/projects/${opened.projectId}/canvases/canvas-1/canvas-map/project-paths`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseRevision: opened.projectRevision,
            projectRelativePath: 'flow/a.png'
          })
        }
      );
      const addB = await harness.fetchOkJson<{ projectRevision: number }>(
        `/api/projects/${opened.projectId}/canvases/canvas-1/canvas-map/project-paths`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseRevision: addA.projectRevision,
            projectRelativePath: 'flow/b.png'
          })
        }
      );

      const response = await harness.fetchJson<WorkbenchCanvasDocumentMutationResult>(
        `/api/projects/${opened.projectId}/canvases/canvas-1/node-stack-order/bring-to-front`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseRevision: addB.projectRevision,
            projectRelativePath: 'flow/a.png'
          })
        }
      );

      expect(response.status).toBe(200);
      const a = response.body.canvas.nodeElements.find((node) => node.projectRelativePath === 'flow/a.png');
      const b = response.body.canvas.nodeElements.find((node) => node.projectRelativePath === 'flow/b.png');
      expect(a?.z).toBeGreaterThan(b?.z ?? -1);
    });
  });

  describe('Canvas video preview routes', { tags: ['canvas-video'] }, () => {
    it('creates an explicit poster source and serves a cached preview variant', async () => {
      await using harness = await DaemonTestHarness.create();
      const project = await harness.createProject({
        'media/clip.mp4': 'video-bytes'
      });
      await sharp({
        create: {
          width: 320,
          height: 180,
          channels: 3,
          background: { r: 80, g: 40, b: 120 }
        }
      }).jpeg().toFile(join(project.rootPath, 'media/clip.jpg'));
      const videoStat = await stat(join(project.rootPath, 'media/clip.mp4'));
      const videoRevision = projectFileRevision(videoStat.size, videoStat.mtimeMs);
      const opened = await harness.fetchOkJson<{ projectId: string }>('/api/projects/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectRoot: project.rootPath })
      });

      const sourcesResponse = await harness.fetchJson<CanvasVideoPreviewSourceResponse>(
        `/api/projects/${opened.projectId}/canvas-video-previews/sources`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            canvasId: 'canvas-1',
            targets: [{
              projectRelativePath: 'media/clip.mp4',
              videoRevision,
              currentTimeSeconds: 0
            }]
          })
        }
      );
      expect(sourcesResponse.status).toBe(200);
      const source = sourcesResponse.body.sources['media/clip.mp4'];
      expect(source).toMatchObject({
        status: 'available',
        sourceKind: 'initial-poster',
        sourceWidth: 320
      });
      if (!source || source.status !== 'available') {
        throw new Error('Expected available source.');
      }

      const imageUrl = new URL(`/api/projects/${opened.projectId}/canvas-video-preview`, harness.daemonUrl);
      imageUrl.searchParams.set('canvasId', 'canvas-1');
      imageUrl.searchParams.set('path', 'media/clip.mp4');
      imageUrl.searchParams.set('videoRevision', videoRevision);
      imageUrl.searchParams.set('t', '0');
      imageUrl.searchParams.set('sourceKey', source.sourceKey);
      imageUrl.searchParams.set('w', '80');
      const image = await fetch(imageUrl, {
        headers: { 'x-debrute-daemon-token': harness.token }
      });

      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toContain('image/jpeg');
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0);
    });
  });
});

async function writeCanvasMap(projectRoot: string, canvasId: string, content: string): Promise<void> {
  await mkdir(join(projectRoot, '.debrute/canvas-maps'), { recursive: true });
  await writeFile(join(projectRoot, `.debrute/canvas-maps/${canvasId}.yaml`), content, 'utf8');
}

function projectMetadata(name: string) {
  return {
    project: {
      id: `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-id`,
      name,
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z'
    }
  };
}

function canvasMapSource(paths: Array<string | { glob: string }>): string {
  return [
    'paths:',
    ...paths.map((path) => typeof path === 'string' ? `  - ${path}` : `  - glob: ${path.glob}`),
    ''
  ].join('\n');
}

function deferredBarrier(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForBarrier(barrier: Promise<void>, description: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      barrier,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), 1000);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
