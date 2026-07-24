import { cp, rm } from 'node:fs/promises';
import { build } from 'esbuild';
import { assembleProductSeed } from '../../../scripts/assemble-product-seed.mjs';

const skipProductSeed = process.argv.includes('--skip-product-seed');

await rm('dist-electron', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  logOverride: {
    'empty-import-meta': 'silent'
  },
  external: ['electron']
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

await cp('build/icon.svg', 'dist-electron/icon.svg');
await cp('build/icon.png', 'dist-electron/icon.png');
await cp('build/dock_icon.png', 'dist-electron/dock_icon.png');

if (!skipProductSeed) {
  await assembleProductSeed();
}
