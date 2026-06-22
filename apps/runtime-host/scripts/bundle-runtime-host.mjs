import { cp, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('bundle', { recursive: true, force: true });

const commonBuildOptions = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
  logOverride: {
    'empty-import-meta': 'silent'
  }
};

await Promise.all([
  build({
    ...commonBuildOptions,
    entryPoints: ['src/cli.ts'],
    outfile: 'bundle/runtime-host.cjs',
    external: ['node-pty', 'sharp']
  }),
  build({
    ...commonBuildOptions,
    entryPoints: ['../app-server/src/canvas/CanvasFeedbackRenderedImageWorker.ts'],
    outfile: 'bundle/canvas-feedback-render-worker.cjs',
    external: ['sharp']
  })
]);

await Promise.all([
  cp(
    '../../packages/capability-runtime/src/imageModels/officialDocs/snapshots',
    'bundle/official-docs/imageModels/snapshots',
    { recursive: true }
  ),
  cp(
    '../../packages/capability-runtime/src/videoModels/officialDocs/snapshots',
    'bundle/official-docs/videoModels/snapshots',
    { recursive: true }
  )
]);
