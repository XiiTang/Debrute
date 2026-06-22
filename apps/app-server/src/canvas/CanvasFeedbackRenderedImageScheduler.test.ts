import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CanvasFeedbackDocument, CanvasFeedbackEntry } from '@debrute/canvas-core';
import { canvasFeedbackRenderedProjectPath } from '@debrute/canvas-core';
import {
  CanvasFeedbackRenderCancelledError,
  createCanvasFeedbackRenderScheduler,
  type CanvasFeedbackRenderDiagnosticUpdate,
  type CanvasFeedbackRenderRunner
} from './CanvasFeedbackRenderedImageScheduler';
import type { CanvasFeedbackRenderJobInput, CanvasFeedbackRenderJobResult } from './CanvasFeedbackRenderedImageWorkerProtocol';

const NOW = '2026-06-21T12:00:00.000Z';

describe('CanvasFeedbackRenderedImageScheduler', () => {
  it('runs different images concurrently and cancels superseded same-image work', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-scheduler-concurrent-'));
    try {
      const runner = new ManualRenderRunner();
      const diagnostics: CanvasFeedbackRenderDiagnosticUpdate[] = [];
      const scheduler = createCanvasFeedbackRenderScheduler({
        runner,
        maxConcurrentImages: 2,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
      });

      scheduler.enqueueSource({
        projectRoot,
        projectRelativePath: 'assets/a.png',
        document: documentFixture(['assets/a.png', 'assets/b.png'])
      });
      scheduler.enqueueSource({
        projectRoot,
        projectRelativePath: 'assets/b.png',
        document: documentFixture(['assets/a.png', 'assets/b.png'])
      });
      await waitFor(() => runner.jobs.length === 2);

      scheduler.enqueueSource({
        projectRoot,
        projectRelativePath: 'assets/a.png',
        document: documentFixture(['assets/a.png', 'assets/b.png'], 'new comment')
      });

      expect(runner.jobs[0]!.signal.aborted).toBe(true);
      await runner.jobs[0]!.rejectCancelled();
      await waitFor(() => runner.jobs.length === 3);

      await runner.jobs[2]!.resolveSuccess('new-a');
      await waitForFile(join(projectRoot, canvasFeedbackRenderedProjectPath('assets/a.png')), 'new-a');
      expect(diagnostics.at(-1)).toMatchObject({
        diagnostics: [],
        checkedProjectRelativePaths: ['assets/a.png']
      });

      await scheduler.dispose();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not publish an older same-image result that completes after supersession', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-scheduler-stale-'));
    try {
      const runner = new ManualRenderRunner();
      const scheduler = createCanvasFeedbackRenderScheduler({
        runner,
        maxConcurrentImages: 1,
        onDiagnostic: () => undefined
      });

      scheduler.enqueueSource({
        projectRoot,
        projectRelativePath: 'assets/page.png',
        document: documentFixture(['assets/page.png'], 'old')
      });
      await waitFor(() => runner.jobs.length === 1);
      scheduler.enqueueSource({
        projectRoot,
        projectRelativePath: 'assets/page.png',
        document: documentFixture(['assets/page.png'], 'new')
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
      const finalPath = join(projectRoot, canvasFeedbackRenderedProjectPath('assets/page.png'));
      await mkdir(join(projectRoot, '.debrute/reviews/rendered-feedback/assets'), { recursive: true });
      await writeFile(finalPath, 'stale');
      const runner = new ManualRenderRunner();
      const diagnostics: CanvasFeedbackRenderDiagnosticUpdate[] = [];
      const scheduler = createCanvasFeedbackRenderScheduler({
        runner,
        maxConcurrentImages: 1,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
      });

      scheduler.enqueueSource({
        projectRoot,
        projectRelativePath: 'assets/page.png',
        document: documentFixture(['assets/page.png'])
      });
      await waitFor(() => runner.jobs.length === 1);
      await runner.jobs[0]!.resolveFailure('source missing');
      await waitFor(() => diagnostics.length === 1);

      await expect(stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(diagnostics[0]).toMatchObject({
        checkedProjectRelativePaths: ['assets/page.png'],
        diagnostics: [{
          id: 'canvas-feedback.render_failed:assets/page.png',
          code: 'canvas-feedback.render_failed',
          entityId: 'assets/page.png'
        }]
      });

      await scheduler.dispose();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes artifacts without invoking the runner when an image has no local regions', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-scheduler-remove-'));
    try {
      const finalPath = join(projectRoot, canvasFeedbackRenderedProjectPath('assets/page.png'));
      await mkdir(join(projectRoot, '.debrute/reviews/rendered-feedback/assets'), { recursive: true });
      await writeFile(finalPath, 'stale');
      const runner = new ManualRenderRunner();
      const diagnostics: CanvasFeedbackRenderDiagnosticUpdate[] = [];
      const scheduler = createCanvasFeedbackRenderScheduler({
        runner,
        maxConcurrentImages: 1,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
      });

      scheduler.enqueueSource({
        projectRoot,
        projectRelativePath: 'assets/page.png',
        document: {
          schemaVersion: 2,
          updatedAt: NOW,
          entries: {}
        }
      });
      await waitFor(() => diagnostics.length === 1);

      expect(runner.jobs).toHaveLength(0);
      await expect(stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
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
        maxConcurrentImages: 1,
        onDiagnostic: () => undefined
      });

      scheduler.enqueueDocument({
        projectRoot,
        document: documentFixture(['assets/page.png'])
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

  it('reports retained local-region paths when reconciling a whole feedback document', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-scheduler-retained-'));
    try {
      const runner = new ManualRenderRunner();
      const diagnostics: CanvasFeedbackRenderDiagnosticUpdate[] = [];
      const scheduler = createCanvasFeedbackRenderScheduler({
        runner,
        maxConcurrentImages: 1,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
      });

      scheduler.enqueueDocument({
        projectRoot,
        document: documentFixture(['assets/page.png'])
      });

      expect(diagnostics.at(-1)).toMatchObject({
        diagnostics: [],
        checkedProjectRelativePaths: [],
        checkedAllEntries: true,
        retainedProjectRelativePaths: ['assets/page.png']
      });

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

function documentFixture(projectRelativePaths: string[], comment = 'fix this'): CanvasFeedbackDocument {
  const entries = Object.fromEntries(projectRelativePaths.map((projectRelativePath) => [
    projectRelativePath,
    entryFixture(projectRelativePath, comment)
  ]));
  return {
    schemaVersion: 2,
    updatedAt: NOW,
    entries
  };
}

function entryFixture(projectRelativePath: string, comment: string): CanvasFeedbackEntry {
  return {
    projectRelativePath,
    marks: [],
    note: '',
    nextRegionLabel: 2,
    regions: [{
      id: 'region-1',
      label: 1,
      kind: 'pin',
      geometry: { type: 'point', x: 0.2, y: 0.3 },
      comment,
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
