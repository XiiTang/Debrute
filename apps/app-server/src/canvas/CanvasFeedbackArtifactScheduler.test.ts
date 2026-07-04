import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canvasFeedbackRenderedMomentProjectPath,
  canvasFeedbackRenderedProjectPath,
  type CanvasFeedbackDocument,
  type CanvasFeedbackEntry
} from '@debrute/canvas-core';
import {
  CanvasFeedbackRenderCancelledError,
  createCanvasFeedbackRenderScheduler,
  type CanvasFeedbackRenderDiagnosticUpdate,
  type CanvasFeedbackRenderRunner
} from './CanvasFeedbackArtifactScheduler';
import type { CanvasFeedbackRenderJobInput, CanvasFeedbackRenderJobResult } from './CanvasFeedbackArtifactWorkerProtocol';

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
      await delay(20);

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

  constructor(private readonly options: { writeOnStart?: boolean } = {}) {}

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
    const job: ManualRenderJob = {
      input,
      signal,
      resolveSuccess: async (content: string) => {
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
    if (this.options.writeOnStart) {
      void mkdir(dirname(input.outputPath), { recursive: true })
        .then(() => writeFile(input.outputPath, 'working'));
    }
    return promise;
  }
}

interface ManualRenderJob {
  input: CanvasFeedbackRenderJobInput;
  signal: AbortSignal;
  resolveSuccess(content: string): Promise<void>;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
