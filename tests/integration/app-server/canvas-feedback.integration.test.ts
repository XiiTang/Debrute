import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CanvasFeedbackRenderCancelledError,
  createCanvasFeedbackRenderScheduler,
  type CanvasFeedbackRenderDiagnosticUpdate,
  type CanvasFeedbackRenderRunner,
  type CanvasFeedbackRenderScheduler
} from '../../../apps/app-server/src/canvas/CanvasFeedbackArtifactScheduler';
import {
  createCanvasFeedbackArtifactProcessRunner,
  resolveCanvasFeedbackRenderWorkerPath
} from '../../../apps/app-server/src/canvas/CanvasFeedbackArtifactProcessRunner';
import {
  type CanvasFeedbackRenderJobInput,
  type CanvasFeedbackRenderJobResult
} from '../../../apps/app-server/src/canvas/CanvasFeedbackArtifactWorkerProtocol';
import {
  canvasFeedbackRenderedMomentProjectPath,
  canvasFeedbackRenderedProjectPath,
  type CanvasFeedbackDocument,
  type CanvasFeedbackEntry
} from '@debrute/canvas-core';
import sharp from 'sharp';
import {
  createCanvasFeedbackOverlaySvg,
  removeCanvasFeedbackRenderedArtifact,
  removeUnexpectedCanvasFeedbackRenderedArtifacts,
  renderCanvasFeedbackArtifact
} from '../../../apps/app-server/src/canvas/CanvasFeedbackArtifactService';
import { type CanvasVideoFrameExtractorInput } from '../../../apps/app-server/src/canvas/CanvasVideoFrameExtractor';
import { createCanvasFeedbackService } from '../../../apps/app-server/src/canvas/CanvasFeedbackService';
import { normalizeFileWatchEvent, type NormalizedFileWatchEvent } from '@debrute/project-core';
import { DebruteAppServer } from '@debrute/app-server';
import { type AppServerEvent } from '@debrute/app-protocol';

describe('app-server Canvas feedback', () => {
  describe('CanvasFeedbackArtifactProcessRunner', () => {
    it('resolves a bundled worker next to the runtime bundle when module URLs are unavailable', () => {
      expect(resolveCanvasFeedbackRenderWorkerPath({
        moduleDirectory: '/Applications/Debrute/resources/app.asar/dist-electron'
      })).toBe('/Applications/Debrute/resources/app.asar/dist-electron/canvas-feedback-artifact-worker.cjs');
    });

    it('resolves a source worker next to the unbundled ESM module', () => {
      expect(resolveCanvasFeedbackRenderWorkerPath({
        moduleUrl: 'file:///repo/apps/app-server/dist/canvas/CanvasFeedbackArtifactProcessRunner.js'
      })).toBe('/repo/apps/app-server/dist/canvas/CanvasFeedbackArtifactWorker.js');
    });

    it('includes the render worker in packaged runtime bundles', async () => {
      const [runtimeHostBundleScript, electronBundleScript] = await Promise.all([
        readFile(new URL('../../../apps/runtime-host/scripts/bundle-runtime-host.mjs', import.meta.url), 'utf8'),
        readFile(new URL('../../../apps/desktop/scripts/bundle-electron.mjs', import.meta.url), 'utf8')
      ]);
      expect(runtimeHostBundleScript).toContain('CanvasFeedbackArtifactWorker.ts');
      expect(runtimeHostBundleScript).toContain('canvas-feedback-artifact-worker.cjs');
      expect(electronBundleScript).toContain('canvas-feedback-artifact-worker.cjs');
    });

    it('runs a render worker process and parses its JSON result', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'debrute-feedback-runner-'));
      try {
        const workerPath = join(tempDir, 'worker.mjs');
        await writeFile(workerPath, `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  const job = JSON.parse(input);
  await import('node:fs/promises').then(({ writeFile }) => writeFile(job.outputPath, 'ok'));
  process.stdout.write(JSON.stringify({ ok: true, jobId: job.jobId, outputPath: job.outputPath, width: 10, height: 20 }));
});
`);
        const runner = createCanvasFeedbackArtifactProcessRunner({ workerPath });
        await expect(runner.render(jobInput(tempDir), new AbortController().signal)).resolves.toMatchObject({
          ok: true,
          jobId: 'job-1',
          width: 10,
          height: 20
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('rejects with cancellation when the abort signal terminates the worker process', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'debrute-feedback-runner-cancel-'));
      try {
        const workerPath = join(tempDir, 'worker.mjs');
        await writeFile(workerPath, 'setTimeout(() => undefined, 30_000);');
        const runner = createCanvasFeedbackArtifactProcessRunner({ workerPath });
        const controller = new AbortController();
        const render = runner.render(jobInput(tempDir), controller.signal);
        controller.abort();
        await expect(render).rejects.toBeInstanceOf(CanvasFeedbackRenderCancelledError);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
  function jobInput(tempDir: string): CanvasFeedbackRenderJobInput {
    return {
      jobId: 'job-1',
      projectRoot: tempDir,
      outputPath: join(tempDir, 'output.png'),
      artifact: {
        kind: 'image',
        projectRelativePath: 'source.png',
        entry: {
          projectRelativePath: 'source.png',
          marks: [],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [],
          updatedAt: '2026-06-21T12:00:00.000Z'
        }
      }
    };
  }
  const NOW = '2026-06-21T12:00:00.000Z';
  describe('CanvasFeedbackArtifactScheduler', () => {
    it('renders image and video moment artifacts derived from the current document', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-scheduler-artifacts-'));
      try {
        const runner = new ManualRenderRunner();
        const diagnostics: CanvasFeedbackRenderDiagnosticUpdate[] = [];
        const scheduler = createCanvasFeedbackRenderScheduler({
          runner,
          maxConcurrentArtifacts: 2,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
        });
        const document = documentFixture({
          'assets/page.png': imageEntry('assets/page.png'),
          'assets/clip.mp4': videoEntry('assets/clip.mp4')
        });
        scheduler.enqueueDocument({ projectRoot, document });
        await waitFor(() => runner.jobs.length === 2);
        const imageJob = runner.jobs.find((job) => job.input.artifact.kind === 'image')!;
        const videoJob = runner.jobs.find((job) => job.input.artifact.kind === 'video-moment')!;
        expect(imageJob.input.artifact).toMatchObject({
          kind: 'image',
          projectRelativePath: 'assets/page.png'
        });
        expect(videoJob.input.artifact).toMatchObject({
          kind: 'video-moment',
          projectRelativePath: 'assets/clip.mp4',
          moment: { label: 'M1', currentTimeSeconds: 4.25 }
        });
        await imageJob.resolveSuccess('image-output');
        await videoJob.resolveSuccess('video-output');
        await waitForFile(join(projectRoot, canvasFeedbackRenderedProjectPath('assets/page.png')), 'image-output');
        await waitForFile(join(projectRoot, canvasFeedbackRenderedMomentProjectPath('assets/clip.mp4', 'M1')), 'video-output');
        expect(diagnostics[0]).toMatchObject({
          diagnostics: [],
          checkedAllEntries: true,
          retainedProjectRelativePaths: ['assets/clip.mp4#M1', 'assets/page.png']
        });
        await scheduler.dispose();
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('does not publish an older same-artifact result that completes after supersession', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-scheduler-stale-'));
      try {
        const runner = new ManualRenderRunner();
        const scheduler = createCanvasFeedbackRenderScheduler({
          runner,
          maxConcurrentArtifacts: 1,
          onDiagnostic: () => undefined
        });
        scheduler.enqueueSource({
          projectRoot,
          projectRelativePath: 'assets/page.png',
          document: documentFixture({ 'assets/page.png': imageEntry('assets/page.png', 'old') })
        });
        await waitFor(() => runner.jobs.length === 1);
        scheduler.enqueueSource({
          projectRoot,
          projectRelativePath: 'assets/page.png',
          document: documentFixture({ 'assets/page.png': imageEntry('assets/page.png', 'new') })
        });
        await runner.jobs[0]!.resolveSuccess('old-output');
        await waitFor(() => runner.jobs.length === 2);
        await expect(stat(join(projectRoot, canvasFeedbackRenderedProjectPath('assets/page.png')))).rejects.toMatchObject({ code: 'ENOENT' });
        await runner.jobs[1]!.resolveSuccess('new-output');
        await waitForFile(join(projectRoot, canvasFeedbackRenderedProjectPath('assets/page.png')), 'new-output');
        await scheduler.dispose();
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('removes stale artifacts and reports render_failed for the latest failed job', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-scheduler-failure-'));
      try {
        const artifactProjectPath = canvasFeedbackRenderedMomentProjectPath('assets/clip.mp4', 'M1');
        const finalPath = join(projectRoot, artifactProjectPath);
        await mkdir(dirname(finalPath), { recursive: true });
        await writeFile(finalPath, 'stale');
        const runner = new ManualRenderRunner();
        const diagnostics: CanvasFeedbackRenderDiagnosticUpdate[] = [];
        const scheduler = createCanvasFeedbackRenderScheduler({
          runner,
          maxConcurrentArtifacts: 1,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
        });
        scheduler.enqueueSource({
          projectRoot,
          projectRelativePath: 'assets/clip.mp4',
          document: documentFixture({ 'assets/clip.mp4': videoEntry('assets/clip.mp4') })
        });
        await waitFor(() => runner.jobs.length === 1);
        await runner.jobs[0]!.resolveFailure('source missing');
        await waitFor(() => diagnostics.some((diagnostic) => diagnostic.diagnostics.length > 0));
        await expect(stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(diagnostics.at(-1)).toMatchObject({
          checkedProjectRelativePaths: ['assets/clip.mp4#M1'],
          diagnostics: [{
            id: 'canvas-feedback.render_failed:assets/clip.mp4#M1',
            code: 'canvas-feedback.render_failed',
            entityId: 'assets/clip.mp4#M1'
          }]
        });
        await scheduler.dispose();
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('removes artifacts without invoking the runner when a source has no artifact items', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-scheduler-remove-'));
      try {
        const imagePath = join(projectRoot, canvasFeedbackRenderedProjectPath('assets/page.png'));
        const momentPath = join(projectRoot, canvasFeedbackRenderedMomentProjectPath('assets/clip.mp4', 'M1'));
        await mkdir(dirname(imagePath), { recursive: true });
        await mkdir(dirname(momentPath), { recursive: true });
        await writeFile(imagePath, 'stale-image');
        await writeFile(momentPath, 'stale-video');
        const runner = new ManualRenderRunner();
        const diagnostics: CanvasFeedbackRenderDiagnosticUpdate[] = [];
        const scheduler = createCanvasFeedbackRenderScheduler({
          runner,
          maxConcurrentArtifacts: 1,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
        });
        scheduler.enqueueSource({
          projectRoot,
          projectRelativePath: 'assets/page.png',
          document: documentFixture({})
        });
        await waitFor(() => diagnostics.length === 1);
        await waitForMissingFile(imagePath);
        await waitForMissingFile(momentPath);
        expect(runner.jobs).toHaveLength(0);
        await expect(stat(imagePath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(momentPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(diagnostics[0]).toMatchObject({
          diagnostics: [],
          checkedProjectRelativePaths: ['assets/page.png']
        });
        await scheduler.dispose();
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('does not prune active temporary outputs while reconciling a feedback document', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-scheduler-temp-'));
      try {
        const runner = new ManualRenderRunner({ writeOnStart: true });
        const scheduler = createCanvasFeedbackRenderScheduler({
          runner,
          maxConcurrentArtifacts: 1,
          onDiagnostic: () => undefined
        });
        scheduler.enqueueDocument({
          projectRoot,
          document: documentFixture({ 'assets/page.png': imageEntry('assets/page.png') })
        });
        await waitFor(() => runner.jobs.length === 1);
        await runner.jobs[0]!.started;
        await expect(stat(runner.jobs[0]!.input.outputPath)).resolves.toMatchObject({ size: 7 });
        await runner.jobs[0]!.resolveSuccess('final');
        await scheduler.dispose();
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  });
  class ManualRenderRunner implements CanvasFeedbackRenderRunner {
    readonly jobs: ManualRenderJob[] = [];
    constructor(private readonly options: {
      writeOnStart?: boolean;
    } = {}) { }
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
      const started = this.options.writeOnStart
        ? mkdir(dirname(input.outputPath), { recursive: true })
          .then(() => writeFile(input.outputPath, 'working'))
        : Promise.resolve();
      const job: ManualRenderJob = {
        input,
        signal,
        started,
        resolveSuccess: async (content = 'ok') => {
          await mkdir(dirname(input.outputPath), { recursive: true });
          await writeFile(input.outputPath, content);
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
        },
        rejectCancelled: async () => {
          rejectCancelled();
        }
      };
      this.jobs.push(job);
      return promise;
    }
  }

  interface ManualRenderJob {
    input: CanvasFeedbackRenderJobInput;
    signal: AbortSignal;
    started: Promise<void>;
    resolveSuccess(content?: string): Promise<void>;
    resolveFailure(message: string): Promise<void>;
    rejectCancelled(): Promise<void>;
  }

  function documentFixture(entries: Record<string, CanvasFeedbackEntry>): CanvasFeedbackDocument {
    return {
      updatedAt: NOW,
      entries
    };
  }

  function imageEntry(projectRelativePath: string, comment = 'fix this'): CanvasFeedbackEntry {
    return {
      projectRelativePath,
      marks: [],
      nextMomentLabel: 1,
      nextSpatialLabel: 2,
      items: [{
        id: 'item-1',
        label: 1,
        kind: 'pin',
        scope: 'file',
        geometry: { type: 'point', x: 0.2, y: 0.3 },
        comment,
        createdAt: NOW,
        updatedAt: NOW
      }],
      updatedAt: NOW
    };
  }

  function videoEntry(projectRelativePath: string): CanvasFeedbackEntry {
    return {
      projectRelativePath,
      marks: [],
      nextMomentLabel: 2,
      nextSpatialLabel: 2,
      items: [{
        id: 'item-comment',
        kind: 'comment',
        scope: 'moment',
        moment: { label: 'M1', currentTimeSeconds: 4.25 },
        comment: 'pause here',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        id: 'item-pin',
        label: 1,
        kind: 'pin',
        scope: 'moment',
        moment: { label: 'M1', currentTimeSeconds: 4.25 },
        geometry: { type: 'point', x: 0.2, y: 0.3 },
        comment: 'look here',
        createdAt: NOW,
        updatedAt: NOW
      }],
      updatedAt: NOW
    };
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for scheduler test condition.');
  }

  async function waitForFile(path: string, expectedContent: string): Promise<void> {
    await waitForAsync(async () => {
      try {
        return await readFile(path, 'utf8') === expectedContent;
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    });
  }

  async function waitForMissingFile(path: string): Promise<void> {
    await waitForAsync(async () => {
      try {
        await stat(path);
        return false;
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return true;
        }
        throw error;
      }
    });
  }

  async function waitForAsync(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for scheduler test condition.');
  }

  function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
  }

  describe('CanvasFeedbackArtifactService', () => {
    it('places rectangular labels at their top-left anchor', () => {
      const overlay = createCanvasFeedbackOverlaySvg({
        width: 200,
        height: 100,
        items: [{
          id: 'item-rect',
          label: 7,
          kind: 'region',
          scope: 'file',
          geometry: { type: 'rect', x: 0.4, y: 0.3, width: 0.2, height: 0.2 },
          comment: 'rect comment',
          createdAt: NOW,
          updatedAt: NOW
        }, {
          id: 'item-edge',
          label: 9,
          kind: 'region',
          scope: 'file',
          geometry: { type: 'rect', x: 0, y: 0, width: 0.1, height: 0.1 },
          comment: 'edge comment',
          createdAt: NOW,
          updatedAt: NOW
        }]
      });
      expect(overlay).toContain('<circle class="badge" cx="80" cy="30" r="15" />');
      expect(overlay).toContain('<text class="label" x="80" y="30">7</text>');
      expect(overlay).toContain('<circle class="badge" cx="0" cy="0" r="15" />');
      expect(overlay).toContain('<text class="label" x="0" y="0">9</text>');
    });

    it('renders image feedback overlays to a caller-owned temporary PNG path', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-render-'));
      try {
        await writeFile(join(projectRoot, 'page.png'), await sharp({
          create: {
            width: 120,
            height: 80,
            channels: 4,
            background: { r: 240, g: 240, b: 240, alpha: 1 }
          }
        }).png().toBuffer());
        const outputPath = join(projectRoot, '.debrute/reviews/rendered-feedback/page.png.annotated.png.job-1.tmp');
        const result = await renderCanvasFeedbackArtifact({
          jobId: 'job-1',
          projectRoot,
          artifact: {
            kind: 'image',
            projectRelativePath: 'page.png',
            entry: entryFixture('page.png')
          },
          outputPath
        });
        expect(result).toMatchObject({
          ok: true,
          jobId: 'job-1',
          outputPath,
          width: 120,
          height: 80
        });
        const output = await sharp(outputPath).metadata();
        expect(output.width).toBe(120);
        expect(output.height).toBe(80);
        expect(output.format).toBe('png');
        const outputBytes = await readFile(outputPath);
        expect(outputBytes.includes(Buffer.from('pin comment'))).toBe(false);
        expect(outputBytes.includes(Buffer.from('rect comment'))).toBe(false);
        expect(await countNonBackgroundPixels(outputPath, { r: 240, g: 240, b: 240 })).toBeGreaterThan(0);
        await expect(stat(join(projectRoot, canvasFeedbackRenderedProjectPath('page.png')))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('renders image feedback overlays from an AVIF source image', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-render-avif-'));
      try {
        await writeFile(join(projectRoot, 'page.avif'), await sharp({
          create: {
            width: 96,
            height: 64,
            channels: 4,
            background: { r: 240, g: 240, b: 240, alpha: 1 }
          }
        }).avif().toBuffer());
        const outputPath = join(projectRoot, '.debrute/reviews/rendered-feedback/page.avif.annotated.png.job-1.tmp');
        const result = await renderCanvasFeedbackArtifact({
          jobId: 'job-1',
          projectRoot,
          artifact: {
            kind: 'image',
            projectRelativePath: 'page.avif',
            entry: entryFixture('page.avif')
          },
          outputPath
        });
        expect(result).toMatchObject({
          ok: true,
          jobId: 'job-1',
          outputPath,
          width: 96,
          height: 64
        });
        const output = await sharp(outputPath).metadata();
        expect(output.width).toBe(96);
        expect(output.height).toBe(64);
        expect(output.format).toBe('png');
        expect(await countNonBackgroundPixels(outputPath, { r: 240, g: 240, b: 240 })).toBeGreaterThan(0);
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('renders video moment artifacts from an extracted frame and moment spatial items', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-video-artifact-'));
      try {
        await writeFile(join(projectRoot, 'frame.png'), await sharp({
          create: {
            width: 160,
            height: 90,
            channels: 4,
            background: { r: 16, g: 16, b: 16, alpha: 1 }
          }
        }).png().toBuffer());
        await writeFile(join(projectRoot, 'clip.mp4'), 'video');
        const extractFrame = vi.fn(async (input: CanvasVideoFrameExtractorInput) => {
          await mkdir(dirname(input.outputAbsolutePath), { recursive: true });
          await copyFile(join(projectRoot, 'frame.png'), input.outputAbsolutePath);
        });
        const outputPath = join(projectRoot, '.debrute/reviews/rendered-feedback/clip.mp4.moment-M1.annotated.png.job-1.tmp');
        const result = await renderCanvasFeedbackArtifact({
          jobId: 'job-1',
          projectRoot,
          artifact: {
            kind: 'video-moment',
            projectRelativePath: 'clip.mp4',
            moment: { label: 'M1', currentTimeSeconds: 4.25 },
            entry: videoEntryFixture('clip.mp4')
          },
          outputPath
        }, {
          frameExtractor: { extractFrame }
        });
        expect(result).toMatchObject({
          ok: true,
          jobId: 'job-1',
          outputPath,
          width: 160,
          height: 90
        });
        expect(extractFrame).toHaveBeenCalledWith(expect.objectContaining({
          projectRelativePath: 'clip.mp4',
          currentTimeSeconds: 4.25
        }));
        const outputBytes = await readFile(outputPath);
        expect(outputBytes.includes(Buffer.from('look here'))).toBe(false);
        expect(await countNonBackgroundPixels(outputPath, { r: 16, g: 16, b: 16 })).toBeGreaterThan(0);
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('renders video moment artifacts even when the moment has only a comment item', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-video-comment-artifact-'));
      try {
        await writeFile(join(projectRoot, 'frame.png'), await sharp({
          create: {
            width: 160,
            height: 90,
            channels: 4,
            background: { r: 16, g: 16, b: 16, alpha: 1 }
          }
        }).png().toBuffer());
        await writeFile(join(projectRoot, 'clip.mp4'), 'video');
        const extractFrame = vi.fn(async (input: CanvasVideoFrameExtractorInput) => {
          await mkdir(dirname(input.outputAbsolutePath), { recursive: true });
          await copyFile(join(projectRoot, 'frame.png'), input.outputAbsolutePath);
        });
        const outputPath = join(projectRoot, '.debrute/reviews/rendered-feedback/clip.mp4.moment-M1.annotated.png.job-1.tmp');
        const result = await renderCanvasFeedbackArtifact({
          jobId: 'job-1',
          projectRoot,
          artifact: {
            kind: 'video-moment',
            projectRelativePath: 'clip.mp4',
            moment: { label: 'M1', currentTimeSeconds: 4.25 },
            entry: videoCommentOnlyEntryFixture('clip.mp4')
          },
          outputPath
        }, {
          frameExtractor: { extractFrame }
        });
        expect(result).toMatchObject({
          ok: true,
          width: 160,
          height: 90
        });
        expect(await countNonBackgroundPixels(outputPath, { r: 16, g: 16, b: 16 })).toBe(0);
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('removes rendered artifacts by artifact project path', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-remove-'));
      try {
        const renderedProjectPath = canvasFeedbackRenderedMomentProjectPath('assets/clip.mp4', 'M1');
        const renderedPath = join(projectRoot, renderedProjectPath);
        await mkdir(dirname(renderedPath), { recursive: true });
        await writeFile(renderedPath, Buffer.from('old'));
        await removeCanvasFeedbackRenderedArtifact(projectRoot, renderedProjectPath);
        await expect(stat(renderedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('reconciles rendered artifacts from the current feedback document', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-current-'));
      try {
        await mkdir(join(projectRoot, 'assets'), { recursive: true });
        await writeFile(join(projectRoot, 'assets/page.png'), await sharp({
          create: {
            width: 64,
            height: 48,
            channels: 4,
            background: { r: 240, g: 240, b: 240, alpha: 1 }
          }
        }).png().toBuffer());
        const obsoleteRenderedPath = join(projectRoot, '.debrute/reviews/rendered-feedback/assets/old.png.annotated.png');
        await mkdir(dirname(obsoleteRenderedPath), { recursive: true });
        await writeFile(obsoleteRenderedPath, Buffer.from('old'));
        await removeUnexpectedCanvasFeedbackRenderedArtifacts(projectRoot, new Set([
          canvasFeedbackRenderedProjectPath('assets/page.png')
        ]));
        await expect(stat(obsoleteRenderedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('keeps in-flight temporary frame files while reconciling rendered artifacts', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-current-temp-'));
      try {
        const expectedRenderedPath = join(projectRoot, canvasFeedbackRenderedMomentProjectPath('assets/clip.mp4', 'M1'));
        const tempFramePath = `${expectedRenderedPath}.job-1.tmp.frame.png`;
        const obsoleteTmpNamedRenderedPath = join(projectRoot, canvasFeedbackRenderedMomentProjectPath('assets/clip.tmp.mp4', 'M1'));
        await mkdir(dirname(tempFramePath), { recursive: true });
        await writeFile(tempFramePath, Buffer.from('frame'));
        await writeFile(obsoleteTmpNamedRenderedPath, Buffer.from('old'));
        await removeUnexpectedCanvasFeedbackRenderedArtifacts(projectRoot, new Set([
          canvasFeedbackRenderedMomentProjectPath('assets/clip.mp4', 'M1')
        ]));
        await expect(stat(tempFramePath)).resolves.toMatchObject({ size: 5 });
        await expect(stat(obsoleteTmpNamedRenderedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  });
  function entryFixture(projectRelativePath: string): CanvasFeedbackEntry {
    return {
      projectRelativePath,
      marks: ['needs_revision'],
      nextMomentLabel: 1,
      nextSpatialLabel: 3,
      items: [{
        id: 'item-1',
        label: 1,
        kind: 'pin',
        scope: 'file',
        geometry: { type: 'point', x: 0.25, y: 0.5 },
        comment: 'pin comment',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        id: 'item-2',
        label: 2,
        kind: 'region',
        scope: 'file',
        geometry: { type: 'rect', x: 0.4, y: 0.2, width: 0.25, height: 0.2 },
        comment: 'rect comment',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        id: 'item-comment',
        kind: 'comment',
        scope: 'file',
        comment: 'overall comment',
        createdAt: NOW,
        updatedAt: NOW
      }],
      updatedAt: NOW
    };
  }

  function videoEntryFixture(projectRelativePath: string): CanvasFeedbackEntry {
    return {
      projectRelativePath,
      marks: [],
      nextMomentLabel: 2,
      nextSpatialLabel: 3,
      items: [{
        id: 'item-comment',
        kind: 'comment',
        scope: 'moment',
        moment: { label: 'M1', currentTimeSeconds: 4.25 },
        comment: 'look here',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        id: 'item-pin',
        kind: 'pin',
        scope: 'moment',
        label: 1,
        geometry: { type: 'point', x: 0.25, y: 0.5 },
        moment: { label: 'M1', currentTimeSeconds: 4.25 },
        comment: 'pin',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        id: 'item-region',
        kind: 'region',
        scope: 'moment',
        label: 2,
        geometry: { type: 'rect', x: 0.4, y: 0.2, width: 0.25, height: 0.2 },
        moment: { label: 'M1', currentTimeSeconds: 4.25 },
        comment: 'rect',
        createdAt: NOW,
        updatedAt: NOW
      }],
      updatedAt: NOW
    };
  }

  function videoCommentOnlyEntryFixture(projectRelativePath: string): CanvasFeedbackEntry {
    return {
      projectRelativePath,
      marks: [],
      nextMomentLabel: 2,
      nextSpatialLabel: 1,
      items: [{
        id: 'item-comment',
        kind: 'comment',
        scope: 'moment',
        moment: { label: 'M1', currentTimeSeconds: 4.25 },
        comment: 'look here',
        createdAt: NOW,
        updatedAt: NOW
      }],
      updatedAt: NOW
    };
  }

  async function countNonBackgroundPixels(path: string, background: {
    r: number;
    g: number;
    b: number;
  }): Promise<number> {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    let changed = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      if (data[offset] !== background.r || data[offset + 1] !== background.g || data[offset + 2] !== background.b) {
        changed += 1;
      }
    }
    return changed;
  }

  describe('CanvasFeedbackService materialization', () => {
    it('writes accepted feedback before queueing artifacts for image spatial items', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-service-'));
      try {
        const events: string[] = [];
        const enqueueSource = vi.fn((input: Parameters<CanvasFeedbackRenderScheduler['enqueueSource']>[0]) => {
          events.push(`enqueue:${input.projectRelativePath}`);
        });
        const renderScheduler = createScheduler({ enqueueSource });
        const service = createCanvasFeedbackService({
          now: () => NOW,
          renderScheduler,
          writeStructuredDocument: async (_projectRoot, _absolutePath, content) => {
            const document = JSON.parse(content) as {
              entries?: unknown;
            };
            events.push(`write:${document.entries && typeof document.entries === 'object' ? 'entries' : 'invalid'}`);
          }
        });
        const result = await service.updateCanvasFeedbackEntry(projectRoot, {
          operation: 'add-item',
          projectRelativePath: 'assets/page.png',
          item: {
            kind: 'pin',
            scope: 'file',
            geometry: { type: 'point', x: 0.2, y: 0.3 },
            comment: 'fix this'
          }
        });
        expect(enqueueSource).toHaveBeenCalledTimes(1);
        expect(enqueueSource).toHaveBeenCalledWith({
          projectRoot,
          document: result,
          projectRelativePath: 'assets/page.png'
        });
        expect(events).toEqual(['write:entries', 'enqueue:assets/page.png']);
        expect(result.entries['assets/page.png']?.items).toHaveLength(1);
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('queues artifacts for video moment comments and spatial items', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-video-moment-'));
      try {
        const renderScheduler = createScheduler();
        let currentContent = JSON.stringify(emptyFeedbackDocument());
        const service = createCanvasFeedbackService({
          now: () => NOW,
          renderScheduler,
          readStructuredDocument: async () => currentContent,
          writeStructuredDocument: async (_projectRoot, _absolutePath, content) => {
            currentContent = content;
          }
        });
        const momentComment = await service.updateCanvasFeedbackEntry(projectRoot, {
          operation: 'add-item',
          projectRelativePath: 'assets/clip.mp4',
          item: {
            kind: 'comment',
            scope: 'moment',
            momentTimeSeconds: 4.25,
            comment: 'pause here'
          }
        });
        const momentPin = await service.updateCanvasFeedbackEntry(projectRoot, {
          operation: 'add-item',
          projectRelativePath: 'assets/clip.mp4',
          item: {
            kind: 'pin',
            scope: 'moment',
            momentTimeSeconds: 4.25,
            geometry: { type: 'point', x: 0.2, y: 0.3 },
            comment: 'look here'
          }
        });
        expect(renderScheduler.enqueueSource).toHaveBeenCalledTimes(2);
        expect(renderScheduler.enqueueSource).toHaveBeenNthCalledWith(1, {
          projectRoot,
          document: momentComment,
          projectRelativePath: 'assets/clip.mp4'
        });
        expect(renderScheduler.enqueueSource).toHaveBeenNthCalledWith(2, {
          projectRoot,
          document: momentPin,
          projectRelativePath: 'assets/clip.mp4'
        });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('does not sync artifacts when the feedback write is rejected', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-write-fail-'));
      try {
        const renderScheduler = createScheduler();
        const service = createCanvasFeedbackService({
          now: () => NOW,
          renderScheduler,
          writeStructuredDocument: async () => {
            throw new Error('write conflict');
          }
        });
        await expect(service.updateCanvasFeedbackEntry(projectRoot, {
          operation: 'add-item',
          projectRelativePath: 'assets/page.png',
          item: {
            kind: 'pin',
            scope: 'file',
            geometry: { type: 'point', x: 0.2, y: 0.3 },
            comment: 'fix this'
          }
        })).rejects.toThrow('write conflict');
        expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('rejects file-scope spatial items for non-image targets before writing feedback', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-non-image-'));
      try {
        const renderScheduler = createScheduler();
        const writeStructuredDocument = vi.fn(async () => undefined);
        const service = createCanvasFeedbackService({
          now: () => NOW,
          renderScheduler,
          writeStructuredDocument
        });
        await expect(service.updateCanvasFeedbackEntry(projectRoot, {
          operation: 'add-item',
          projectRelativePath: 'copy.md',
          item: {
            kind: 'pin',
            scope: 'file',
            geometry: { type: 'point', x: 0.2, y: 0.3 },
            comment: 'fix this'
          }
        })).rejects.toThrow('Canvas feedback file-scope spatial items require an image file: copy.md');
        expect(writeStructuredDocument).not.toHaveBeenCalled();
        expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('rejects moment items for non-video targets before writing feedback', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-moment-non-video-'));
      try {
        const renderScheduler = createScheduler();
        const writeStructuredDocument = vi.fn(async () => undefined);
        const service = createCanvasFeedbackService({
          now: () => NOW,
          renderScheduler,
          writeStructuredDocument
        });
        await expect(service.updateCanvasFeedbackEntry(projectRoot, {
          operation: 'add-item',
          projectRelativePath: 'assets/page.png',
          item: {
            kind: 'comment',
            scope: 'moment',
            momentTimeSeconds: 2,
            comment: 'wrong target'
          }
        })).rejects.toThrow('Canvas feedback moment items require a video file: assets/page.png');
        expect(writeStructuredDocument).not.toHaveBeenCalled();
        expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('allows file-level feedback for non-image targets without queueing artifact rendering', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-non-image-entry-'));
      try {
        const renderScheduler = createScheduler();
        let currentContent = JSON.stringify(emptyFeedbackDocument());
        const writeStructuredDocument = vi.fn(async (_projectRoot, _absolutePath, content: string) => {
          currentContent = content;
        });
        const service = createCanvasFeedbackService({
          now: () => NOW,
          renderScheduler,
          readStructuredDocument: async () => currentContent,
          writeStructuredDocument
        });
        const marksResult = await service.updateCanvasFeedbackEntry(projectRoot, {
          operation: 'set-marks',
          projectRelativePath: 'copy.md',
          marks: ['needs_revision']
        });
        const commentResult = await service.updateCanvasFeedbackEntry(projectRoot, {
          operation: 'add-item',
          projectRelativePath: 'copy.md',
          item: { kind: 'comment', scope: 'file', comment: 'revise copy' }
        });
        expect(marksResult.entries['copy.md']).toMatchObject({
          marks: ['needs_revision'],
          items: []
        });
        expect(commentResult.entries['copy.md']).toMatchObject({
          marks: ['needs_revision'],
          items: [{
            kind: 'comment',
            scope: 'file',
            comment: 'revise copy',
            createdAt: NOW,
            updatedAt: NOW
          }]
        });
        expect(writeStructuredDocument).toHaveBeenCalledTimes(2);
        expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('does not queue artifacts for item text updates or mark updates', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-comment-only-'));
      try {
        const renderScheduler = createScheduler();
        let currentContent = JSON.stringify(feedbackDocument({
          'assets/page.png': serviceImageEntry()
        }));
        const service = createCanvasFeedbackService({
          now: () => NOW,
          renderScheduler,
          readStructuredDocument: async () => currentContent,
          writeStructuredDocument: async (_projectRoot, _absolutePath, content) => {
            currentContent = content;
          }
        });
        await service.updateCanvasFeedbackEntry(projectRoot, {
          operation: 'update-item',
          projectRelativePath: 'assets/page.png',
          itemId: 'item-1',
          comment: 'new region comment'
        });
        await service.updateCanvasFeedbackEntry(projectRoot, {
          operation: 'set-marks',
          projectRelativePath: 'assets/page.png',
          marks: ['needs_revision']
        });
        await service.updateCanvasFeedbackEntry(projectRoot, {
          operation: 'add-item',
          projectRelativePath: 'assets/page.png',
          item: { kind: 'comment', scope: 'file', comment: 'overall comment' }
        });
        expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('queues artifacts for geometry-affecting feedback updates and item deletion', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-geometry-update-'));
      try {
        const renderScheduler = createScheduler();
        let currentContent = JSON.stringify(feedbackDocument({
          'assets/page.png': serviceImageEntry()
        }));
        const service = createCanvasFeedbackService({
          now: () => NOW,
          renderScheduler,
          readStructuredDocument: async () => currentContent,
          writeStructuredDocument: async (_projectRoot, _absolutePath, content) => {
            currentContent = content;
          }
        });
        const updateResult = await service.updateCanvasFeedbackEntry(projectRoot, {
          operation: 'update-item',
          projectRelativePath: 'assets/page.png',
          itemId: 'item-1',
          geometry: { type: 'point', x: 0.4, y: 0.5 }
        });
        const deleteResult = await service.updateCanvasFeedbackEntry(projectRoot, {
          operation: 'delete-item',
          projectRelativePath: 'assets/page.png',
          itemId: 'item-1'
        });
        expect(renderScheduler.enqueueSource).toHaveBeenNthCalledWith(1, {
          projectRoot,
          document: updateResult,
          projectRelativePath: 'assets/page.png'
        });
        expect(renderScheduler.enqueueSource).toHaveBeenNthCalledWith(2, {
          projectRoot,
          document: deleteResult,
          projectRelativePath: 'assets/page.png'
        });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('renders the current feedback entry when its source changes', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-source-'));
      try {
        const renderScheduler = createScheduler();
        const service = createCanvasFeedbackService({
          now: () => NOW,
          renderScheduler,
          readStructuredDocument: async () => JSON.stringify(feedbackDocument({
            'assets/page.png': serviceImageEntry()
          }))
        });
        await service.queueRenderedFeedbackForSource(projectRoot, 'assets/page.png');
        expect(renderScheduler.enqueueSource).toHaveBeenCalledWith({
          projectRoot,
          document: expect.objectContaining({ entries: expect.any(Object) }),
          projectRelativePath: 'assets/page.png'
        });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('syncs the current feedback document when the feedback file changes externally', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-document-'));
      try {
        const renderScheduler = createScheduler();
        const service = createCanvasFeedbackService({
          now: () => NOW,
          renderScheduler,
          readStructuredDocument: async () => JSON.stringify(feedbackDocument({
            'assets/page.png': serviceImageEntry(),
            'assets/clip.mp4': serviceVideoEntry()
          }))
        });
        await service.queueRenderedFeedbackDocument(projectRoot);
        expect(renderScheduler.enqueueDocument).toHaveBeenCalledWith({
          projectRoot,
          document: expect.objectContaining({ entries: expect.any(Object) })
        });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('rejects externally edited invalid scopes before queueing renders', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-document-non-image-'));
      try {
        const renderScheduler = createScheduler();
        const service = createCanvasFeedbackService({
          now: () => NOW,
          renderScheduler,
          readStructuredDocument: async () => JSON.stringify(feedbackDocument({
            'copy.md': {
              ...serviceImageEntry(),
              projectRelativePath: 'copy.md'
            }
          }))
        });
        await expect(service.queueRenderedFeedbackDocument(projectRoot))
          .rejects.toThrow('Canvas feedback file-scope spatial items require an image file: copy.md');
        expect(renderScheduler.enqueueDocument).not.toHaveBeenCalled();
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  });
  function emptyFeedbackDocument(): object {
    return {
      updatedAt: NOW,
      entries: {}
    };
  }

  function feedbackDocument(entries: Record<string, object>): object {
    return {
      updatedAt: NOW,
      entries
    };
  }

  function serviceImageEntry(): object {
    return {
      projectRelativePath: 'assets/page.png',
      marks: [],
      nextMomentLabel: 1,
      nextSpatialLabel: 2,
      items: [{
        id: 'item-1',
        kind: 'pin',
        scope: 'file',
        label: 1,
        geometry: { type: 'point', x: 0.2, y: 0.3 },
        comment: 'fix this',
        createdAt: NOW,
        updatedAt: NOW
      }],
      updatedAt: NOW
    };
  }

  function serviceVideoEntry(): object {
    return {
      projectRelativePath: 'assets/clip.mp4',
      marks: [],
      nextMomentLabel: 2,
      nextSpatialLabel: 1,
      items: [{
        id: 'item-1',
        kind: 'comment',
        scope: 'moment',
        moment: { label: 'M1', currentTimeSeconds: 4.25 },
        comment: 'pause here',
        createdAt: NOW,
        updatedAt: NOW
      }],
      updatedAt: NOW
    };
  }

  function createScheduler(overrides: Partial<CanvasFeedbackRenderScheduler> = {}): CanvasFeedbackRenderScheduler {
    return {
      enqueueDocument: vi.fn(),
      enqueueSource: vi.fn(),
      cancelProject: vi.fn(),
      dispose: vi.fn(async () => undefined),
      ...overrides
    };
  }

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
        expect(runner.jobs[0]!.input.artifact.projectRelativePath).toBe('page.png');
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
          operation: 'add-item',
          projectRelativePath: 'page.png',
          item: {
            kind: 'pin',
            scope: 'file',
            geometry: { type: 'point', x: 0.2, y: 0.3 },
            comment: 'fix this'
          }
        });
        expect(feedback.entries['page.png']?.items).toHaveLength(1);
        expect(feedbackChanges).toHaveLength(1);
        expect(runner.jobs.at(-1)?.input.artifact.projectRelativePath).toBe('page.png');
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

    it('clears render_failed diagnostics after the same artifact rerenders successfully', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-render-diagnostic-clear-'));
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
        await server.updateCanvasFeedbackEntry({
          operation: 'update-item',
          projectRelativePath: 'page.png',
          itemId: 'region-1',
          geometry: { type: 'point', x: 0.25, y: 0.5 }
        });
        await waitFor(() => runner.jobs.length === 2);
        await runner.jobs[1]!.resolveSuccess();
        await waitFor(() => server.currentSnapshot()?.diagnostics.some((diagnostic) => diagnostic.code === 'canvas-feedback.render_failed') === false);
      } finally {
        server.close();
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('uses the artifact concurrency limit for Canvas feedback materialization', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-artifact-concurrency-'));
      const runner = new ManualRenderRunner();
      const server = new DebruteAppServer({
        canvasFeedbackRenderRunner: runner,
        canvasFeedbackRenderMaxConcurrentArtifacts: 1
      });
      try {
        await writeImageFixture(projectRoot, 'page-a.png');
        await writeImageFixture(projectRoot, 'page-b.png');
        await writeFeedbackDocument(projectRoot, ['page-a.png', 'page-b.png']);
        await server.openProject(projectRoot, {
          initializeIfMissing: true,
          createDefaultCanvas: true,
          watchFiles: false
        });
        expect(runner.jobs).toHaveLength(1);
        await runner.jobs[0]!.resolveSuccess();
        await waitFor(() => runner.jobs.length === 2);
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
              nextMomentLabel: 1,
              nextSpatialLabel: 2,
              items: [{
                id: 'region-1',
                label: 1,
                kind: 'pin',
                scope: 'file',
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

  async function writeFeedbackDocument(projectRoot: string, projectRelativePaths: string[]): Promise<void> {
    await mkdir(join(projectRoot, '.debrute/reviews'), { recursive: true });
    await writeFile(join(projectRoot, '.debrute/reviews/canvas-feedback.json'), `${JSON.stringify({
      updatedAt: NOW,
      entries: Object.fromEntries(projectRelativePaths.map((projectRelativePath) => [
        projectRelativePath,
        {
          projectRelativePath,
          marks: [],
          nextMomentLabel: 1,
          nextSpatialLabel: 2,
          items: [{
            id: 'region-1',
            label: 1,
            kind: 'pin',
            scope: 'file',
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
        entries: {}
      });
      expect(feedback.updatedAt).toEqual(expect.any(String));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('writes, preserves, and clears Canvas feedback mark entries', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-feedback-write-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      const first = await server.updateCanvasFeedbackEntry({
        operation: 'set-marks',
        projectRelativePath: 'flow/a.png',
        marks: ['cross', 'like']
      });
      const second = await server.updateCanvasFeedbackEntry({
        operation: 'set-marks',
        projectRelativePath: 'flow/b.png',
        marks: ['needs_revision']
      });
      const cleared = await server.updateCanvasFeedbackEntry({
        operation: 'set-marks',
        projectRelativePath: 'flow/a.png',
        marks: []
      });
      expect(first.entries['flow/a.png']).toMatchObject({
        projectRelativePath: 'flow/a.png',
        marks: ['like', 'cross'],
        nextMomentLabel: 1,
        nextSpatialLabel: 1,
        items: []
      });
      expect(second.entries['flow/a.png']).toBeDefined();
      expect(second.entries['flow/b.png']).toMatchObject({
        marks: ['needs_revision'],
        nextMomentLabel: 1,
        nextSpatialLabel: 1,
        items: []
      });
      expect(cleared.entries['flow/a.png']).toBeUndefined();
      expect(cleared.entries['flow/b.png']).toMatchObject({
        projectRelativePath: 'flow/b.png',
        marks: ['needs_revision'],
        nextMomentLabel: 1,
        nextSpatialLabel: 1,
        items: []
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
        operation: 'add-item',
        projectRelativePath: 'brief.md',
        item: {
          kind: 'comment',
          scope: 'file',
          comment: 'Use this direction'
        }
      });
      unsubscribe();
      expect(events.find((event) => event.type === 'canvas.feedback.changed')).toMatchObject({
        type: 'canvas.feedback.changed',
        feedback: {
          entries: {
            'brief.md': {
              projectRelativePath: 'brief.md',
              marks: [],
              nextMomentLabel: 1,
              nextSpatialLabel: 1,
              items: [expect.objectContaining({
                kind: 'comment',
                scope: 'file',
                comment: 'Use this direction'
              })]
            }
          }
        }
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
          operation: 'set-marks',
          projectRelativePath: `flow/${index}.png`,
          marks: ['like']
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
      await writeFile(feedbackPath, '{"entries":', 'utf8');
      await expect(server.updateCanvasFeedbackEntry({
        operation: 'set-marks',
        projectRelativePath: 'flow/a.png',
        marks: ['like']
      })).rejects.toThrow();
      expect(await readFile(feedbackPath, 'utf8')).toBe('{"entries":');
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
  async function readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  }
});
