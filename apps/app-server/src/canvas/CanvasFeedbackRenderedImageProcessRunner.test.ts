import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CanvasFeedbackRenderCancelledError } from './CanvasFeedbackRenderedImageScheduler';
import {
  createCanvasFeedbackRenderedImageProcessRunner,
  resolveCanvasFeedbackRenderWorkerPath
} from './CanvasFeedbackRenderedImageProcessRunner';
import type { CanvasFeedbackRenderJobInput } from './CanvasFeedbackRenderedImageWorkerProtocol';

describe('CanvasFeedbackRenderedImageProcessRunner', () => {
  it('resolves a bundled worker next to the runtime bundle when module URLs are unavailable', () => {
    expect(resolveCanvasFeedbackRenderWorkerPath({
      moduleDirectory: '/Applications/Debrute/resources/app.asar/dist-electron'
    })).toBe('/Applications/Debrute/resources/app.asar/dist-electron/canvas-feedback-render-worker.cjs');
  });

  it('resolves a source worker next to the unbundled ESM module', () => {
    expect(resolveCanvasFeedbackRenderWorkerPath({
      moduleUrl: 'file:///repo/apps/app-server/dist/canvas/CanvasFeedbackRenderedImageProcessRunner.js'
    })).toBe('/repo/apps/app-server/dist/canvas/CanvasFeedbackRenderedImageWorker.js');
  });

  it('includes the render worker in packaged runtime bundles', async () => {
    const [runtimeHostBundleScript, electronBundleScript] = await Promise.all([
      readFile(new URL('../../../runtime-host/scripts/bundle-runtime-host.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../../../desktop/scripts/bundle-electron.mjs', import.meta.url), 'utf8')
    ]);

    expect(runtimeHostBundleScript).toContain('CanvasFeedbackRenderedImageWorker.ts');
    expect(runtimeHostBundleScript).toContain('canvas-feedback-render-worker.cjs');
    expect(electronBundleScript).toContain('canvas-feedback-render-worker.cjs');
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
      const runner = createCanvasFeedbackRenderedImageProcessRunner({ workerPath });

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
      const runner = createCanvasFeedbackRenderedImageProcessRunner({ workerPath });
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
    entry: {
      projectRelativePath: 'source.png',
      marks: [],
      comments: [],
      nextRegionLabel: 1,
      regions: [],
      updatedAt: '2026-06-21T12:00:00.000Z'
    }
  };
}
