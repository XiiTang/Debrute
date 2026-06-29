import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  canvasFeedbackRenderedProjectPath,
  canvasTextPreviewSourceProjectPath
} from '@debrute/canvas-core';
import {
  normalizeFileWatchEvent,
  projectFileRevision,
  projectRelativePathCacheKey,
  projectRevisionCacheKey,
  type NormalizedFileWatchEvent
} from '@debrute/project-core';
import { DebruteAppServer } from './DebruteAppServer';
import {
  CanvasFeedbackRenderCancelledError,
  type CanvasFeedbackRenderRunner
} from '../canvas/CanvasFeedbackRenderedImageScheduler';
import type { CanvasFeedbackRenderJobInput, CanvasFeedbackRenderJobResult } from '../canvas/CanvasFeedbackRenderedImageWorkerProtocol';

const NOW = '2026-06-21T12:00:00.000Z';
const PROTECTED_BATCH_OUTPUT_PATHS = ['.git/config', '.debrute/project.json'] as const;

describe('DebruteAppServer image model batch paths', () => {
  it('rejects batch log paths that target protected project metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-batch-log-path-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });

      for (const logPath of PROTECTED_BATCH_OUTPUT_PATHS) {
        await expect(server.runImageModelBatch(imageBatchInput({
          logPath
        }))).rejects.toThrow(/Project path is (not visible in the Project Tree|protected by the Project Document System)/);
      }
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects batch summary paths that target protected project metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-batch-summary-path-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });

      for (const summaryPath of PROTECTED_BATCH_OUTPUT_PATHS) {
        await expect(server.runImageModelBatch(imageBatchInput({
          logPath: 'batch/results.jsonl',
          summaryPath
        }))).rejects.toThrow(/Project path is (not visible in the Project Tree|protected by the Project Document System)/);
      }
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('allows visible batch log and summary paths', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-batch-visible-paths-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });

      const summary = await server.runImageModelBatch(imageBatchInput({
        logPath: 'batch/results.jsonl',
        summaryPath: 'batch/summary.json'
      }));

      expect(summary).toMatchObject({
        total: 1,
        failedCount: 1,
        logPath: 'batch/results.jsonl',
        summaryPath: 'batch/summary.json'
      });
      expect(await readFile(join(projectRoot, 'batch/results.jsonl'), 'utf8')).toContain('"status":"failed"');
      expect(JSON.parse(await readFile(join(projectRoot, 'batch/summary.json'), 'utf8'))).toMatchObject({
        total: 1,
        failedCount: 1,
        logPath: 'batch/results.jsonl',
        summaryPath: 'batch/summary.json'
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('DebruteAppServer Canvas image preview cache cleanup', () => {
  it('reconciles Canvas image preview cache when opening a project', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-open-preview-cleanup-'));
    const server = new DebruteAppServer();
    try {
      await writeImageFixture(projectRoot, 'images/cover.png');
      const fixture = await writeImagePreviewCacheRevisionFixtures(projectRoot, 'images/cover.png');

      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });

      await expect(readdir(fixture.sourceCacheRoot)).resolves.toEqual([fixture.currentRevisionKey]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reconciles Canvas image preview cache when refreshing a project', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-refresh-preview-cleanup-'));
    const server = new DebruteAppServer();
    try {
      await writeImageFixture(projectRoot, 'images/cover.png');
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });
      const fixture = await writeImagePreviewCacheRevisionFixtures(projectRoot, 'images/cover.png');

      await server.refreshProject();

      await expect(readdir(fixture.sourceCacheRoot)).resolves.toEqual([fixture.currentRevisionKey]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

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
        available: true
      });
      await expect(stat(sourcePath)).resolves.toBeTruthy();
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('DebruteAppServer Canvas feedback materialization', () => {
  it('queues rendered Canvas feedback artifacts when opening a project without waiting for publication', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-open-feedback-'));
    const runner = new ManualRenderRunner();
    const server = new DebruteAppServer({ canvasFeedbackRenderRunner: runner });
    try {
      await writeImageFixture(projectRoot, 'page.png');
      await writeFeedbackDocument(projectRoot, ['page.png']);

      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });

      expect(runner.jobs).toHaveLength(1);
      expect(runner.jobs[0]!.input.entry.projectRelativePath).toBe('page.png');
      await expect(stat(join(projectRoot, canvasFeedbackRenderedProjectPath('page.png')))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('emits accepted feedback immediately when GUI feedback changes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-update-feedback-'));
    const runner = new ManualRenderRunner();
    const server = new DebruteAppServer({ canvasFeedbackRenderRunner: runner });
    const feedbackChanges: unknown[] = [];
    server.onEvent((event) => {
      if (event.type === 'canvas.feedback.changed') {
        feedbackChanges.push(event.feedback);
      }
    });
    try {
      await writeImageFixture(projectRoot, 'page.png');
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });

      const feedback = await server.updateCanvasFeedbackEntry({
        operation: 'add-region',
        projectRelativePath: 'page.png',
        region: {
          kind: 'pin',
          geometry: { type: 'point', x: 0.2, y: 0.3 },
          comment: 'fix this'
        }
      });

      expect(feedback.entries['page.png']?.regions).toHaveLength(1);
      expect(feedbackChanges).toHaveLength(1);
      expect(runner.jobs.at(-1)?.input.entry.projectRelativePath).toBe('page.png');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('records render_failed diagnostics from asynchronous materialization', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-render-diagnostic-'));
    const runner = new ManualRenderRunner();
    const server = new DebruteAppServer({ canvasFeedbackRenderRunner: runner });
    try {
      await writeImageFixture(projectRoot, 'page.png');
      await writeFeedbackDocument(projectRoot, ['page.png']);
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });

      await runner.jobs[0]!.resolveFailure('render failed');
      await waitFor(() => server.currentSnapshot()?.diagnostics.some((diagnostic) => diagnostic.code === 'canvas-feedback.render_failed') === true);

      expect(server.currentSnapshot()?.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'canvas-feedback.render_failed:page.png',
          code: 'canvas-feedback.render_failed',
          entityId: 'page.png'
        })
      ]));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('records and clears document_invalid diagnostics for external feedback JSON edits', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-document-invalid-'));
    const runner = new ManualRenderRunner();
    const server = new DebruteAppServer({ canvasFeedbackRenderRunner: runner });
    try {
      await writeImageFixture(projectRoot, 'page.png');
      await writeFeedbackDocument(projectRoot, ['page.png']);
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });
      const feedbackPath = join(projectRoot, '.debrute/reviews/canvas-feedback.json');

      await writeFile(feedbackPath, '{ invalid json');
      await handleWatchedFileEvent(server, normalizeFileWatchEvent(projectRoot, feedbackPath, 'changed'));

      expect(server.currentSnapshot()?.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'canvas-feedback.document_invalid',
          code: 'canvas-feedback.document_invalid'
        })
      ]));

      await writeFeedbackDocument(projectRoot, []);
      await handleWatchedFileEvent(server, normalizeFileWatchEvent(projectRoot, feedbackPath, 'changed'));

      expect(server.currentSnapshot()?.diagnostics.some((diagnostic) => diagnostic.code === 'canvas-feedback.document_invalid')).toBe(false);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('opens projects with invalid current feedback JSON and surfaces a document diagnostic', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-open-invalid-'));
    const runner = new ManualRenderRunner();
    const server = new DebruteAppServer({ canvasFeedbackRenderRunner: runner });
    try {
      await writeImageFixture(projectRoot, 'page.png');
      await mkdir(join(projectRoot, '.debrute/reviews'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/reviews/canvas-feedback.json'), '{ invalid json');

      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });

      expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'canvas-feedback.document_invalid',
          code: 'canvas-feedback.document_invalid'
        })
      ]));
      expect(server.currentSnapshot()?.diagnostics).toEqual(snapshot.diagnostics);
      expect(runner.jobs).toHaveLength(0);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('treats external local feedback regions on non-image files as an invalid feedback document', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-non-image-document-invalid-'));
    const runner = new ManualRenderRunner();
    const server = new DebruteAppServer({ canvasFeedbackRenderRunner: runner });
    try {
      await writeImageFixture(projectRoot, 'page.png');
      await writeFeedbackDocument(projectRoot, []);
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });
      const feedbackPath = join(projectRoot, '.debrute/reviews/canvas-feedback.json');
      await writeFile(feedbackPath, `${JSON.stringify({
        updatedAt: NOW,
        entries: {
          'copy.md': {
            projectRelativePath: 'copy.md',
            marks: [],
            comments: [],
            nextRegionLabel: 2,
            regions: [{
              id: 'region-1',
              label: 1,
              kind: 'pin',
              geometry: { type: 'point', x: 0.5, y: 0.5 },
              comment: 'center',
              createdAt: NOW,
              updatedAt: NOW
            }],
            updatedAt: NOW
          }
        }
      }, null, 2)}\n`);

      await handleWatchedFileEvent(server, normalizeFileWatchEvent(projectRoot, feedbackPath, 'changed'));

      expect(server.currentSnapshot()?.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'canvas-feedback.document_invalid',
          code: 'canvas-feedback.document_invalid'
        })
      ]));
      expect(runner.jobs).toHaveLength(0);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

class ManualRenderRunner implements CanvasFeedbackRenderRunner {
  readonly jobs: ManualRenderJob[] = [];

  render(input: CanvasFeedbackRenderJobInput, signal: AbortSignal): Promise<CanvasFeedbackRenderJobResult> {
    let resolveJob!: (result: CanvasFeedbackRenderJobResult) => void;
    let rejectJob!: (error: unknown) => void;
    const promise = new Promise<CanvasFeedbackRenderJobResult>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const rejectCancelled = () => {
      rejectJob(new CanvasFeedbackRenderCancelledError());
    };
    if (signal.aborted) {
      rejectCancelled();
    } else {
      signal.addEventListener('abort', rejectCancelled, { once: true });
    }
    void promise.then(() => {
      signal.removeEventListener('abort', rejectCancelled);
    }, () => {
      signal.removeEventListener('abort', rejectCancelled);
    });
    this.jobs.push({
      input,
      signal,
      resolveSuccess: async () => {
        await mkdir(dirname(input.outputPath), { recursive: true });
        await writeFile(input.outputPath, 'ok');
        resolveJob({
          ok: true,
          jobId: input.jobId,
          outputPath: input.outputPath,
          width: 10,
          height: 10
        });
      },
      resolveFailure: async (message: string) => {
        resolveJob({
          ok: false,
          jobId: input.jobId,
          message
        });
      }
    });
    return promise;
  }
}

interface ManualRenderJob {
  input: CanvasFeedbackRenderJobInput;
  signal: AbortSignal;
  resolveSuccess(): Promise<void>;
  resolveFailure(message: string): Promise<void>;
}

function imageBatchInput(input: { logPath: string; summaryPath?: string }) {
  return {
    source: {
      kind: 'requests' as const,
      requests: [{
        model: 'missing-image-model',
        arguments: { prompt: 'test' }
      }]
    },
    concurrency: 1,
    retries: 0,
    logPath: input.logPath,
    ...(input.summaryPath === undefined ? {} : { summaryPath: input.summaryPath })
  };
}

async function writeImageFixture(projectRoot: string, projectRelativePath: string): Promise<void> {
  await mkdir(dirname(join(projectRoot, projectRelativePath)), { recursive: true });
  await writeFile(join(projectRoot, projectRelativePath), await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 4,
      background: { r: 240, g: 240, b: 240, alpha: 1 }
    }
  }).png().toBuffer());
}

async function writeImagePreviewCacheRevisionFixtures(
  projectRoot: string,
  projectRelativePath: string
): Promise<{ sourceCacheRoot: string; currentRevisionKey: string }> {
  const sourceStat = await stat(join(projectRoot, projectRelativePath));
  const sourceKey = projectRelativePathCacheKey(projectRelativePath);
  const currentRevisionKey = projectRevisionCacheKey(projectFileRevision(sourceStat.size, sourceStat.mtimeMs));
  const sourceCacheRoot = join(projectRoot, '.debrute/cache/canvas-image-previews', sourceKey);
  await mkdir(join(sourceCacheRoot, currentRevisionKey), { recursive: true });
  await writeFile(join(sourceCacheRoot, currentRevisionKey, 'preview-w32.jpg'), 'current');
  await mkdir(join(sourceCacheRoot, 'old%3A10'), { recursive: true });
  await writeFile(join(sourceCacheRoot, 'old%3A10', 'preview-w32.jpg'), 'old');
  return {
    sourceCacheRoot,
    currentRevisionKey
  };
}

async function writeFeedbackDocument(projectRoot: string, projectRelativePaths: string[]): Promise<void> {
  await mkdir(join(projectRoot, '.debrute/reviews'), { recursive: true });
  await writeFile(join(projectRoot, '.debrute/reviews/canvas-feedback.json'), `${JSON.stringify({
    updatedAt: NOW,
    entries: Object.fromEntries(projectRelativePaths.map((projectRelativePath) => [
      projectRelativePath,
      {
        projectRelativePath,
        marks: [],
        comments: [],
        nextRegionLabel: 2,
        regions: [{
          id: 'region-1',
          label: 1,
          kind: 'pin',
          geometry: { type: 'point', x: 0.5, y: 0.5 },
          comment: 'center',
          createdAt: NOW,
          updatedAt: NOW
        }],
        updatedAt: NOW
      }
    ]))
  }, null, 2)}\n`);
}

async function handleWatchedFileEvent(server: DebruteAppServer, event: NormalizedFileWatchEvent): Promise<void> {
  const observedAt = Date.now() + 1000;
  await utimes(event.absolutePath, observedAt / 1000, observedAt / 1000);
  await (server as unknown as {
    handleWatchedFileEvent(event: NormalizedFileWatchEvent): Promise<void>;
  }).handleWatchedFileEvent({ ...event, observedAt });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for app-server test condition.');
}
