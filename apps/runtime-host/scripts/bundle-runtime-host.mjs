import { cp, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const withSourcemap = process.argv.includes('--sourcemap');

await rm('bundle', { recursive: true, force: true });

const commonBuildOptions = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: withSourcemap,
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
    entryPoints: ['../app-server/src/canvas/CanvasFeedbackArtifactWorker.ts'],
    outfile: 'bundle/canvas-feedback-artifact-worker.cjs',
    external: ['sharp']
  }),
  build({
    ...commonBuildOptions,
    entryPoints: ['src/productReplacementHelper.ts'],
    outfile: 'bundle/product-replacement-helper.cjs',
    external: ['node-pty', 'sharp']
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
