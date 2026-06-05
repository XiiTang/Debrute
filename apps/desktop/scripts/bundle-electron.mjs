import { cp, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const skipWebDist = process.argv.includes('--skip-web-dist');

await rm('dist-electron', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logOverride: {
    'empty-import-meta': 'silent'
  },
  external: ['electron', 'sharp']
};

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/electron/main.ts'],
    outfile: 'dist-electron/main.js'
  }),
  build({
    ...common,
    entryPoints: ['src/electron/preload.ts'],
    outfile: 'dist-electron/preload.js'
  })
]);

if (!skipWebDist) {
  await cp('../web/dist', 'dist', { recursive: true });
}

await cp(
  '../../packages/capability-runtime/src/imageModels/officialDocs/snapshots',
  'dist-electron/snapshots',
  { recursive: true }
);
