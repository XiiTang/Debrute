import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { packageDebruteCliRuntimePayload } from '../../../scripts/package-debrute-cli.mjs';
import { packageManagerCommand } from '../../../scripts/package-manager-command.mjs';

const skipWebDist = process.argv.includes('--skip-web-dist');
const withSourcemap = process.argv.includes('--sourcemap');
const workspaceRoot = '../..';
const runtimeHostBuild = packageManagerCommand(workspaceRoot, [
  '--filter',
  '@debrute/runtime-host',
  'build',
  ...(withSourcemap ? ['--', '--sourcemap'] : [])
]);

execFileSync(runtimeHostBuild.command, runtimeHostBuild.args, {
  cwd: workspaceRoot,
  stdio: 'inherit'
});

await rm('dist-electron', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: withSourcemap,
  logOverride: {
    'empty-import-meta': 'silent'
  },
  external: ['electron', 'node-pty', 'sharp']
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

await cp('../runtime-host/bundle/runtime-host.cjs', 'dist-electron/runtime-host.cjs');
await cp('../runtime-host/bundle/canvas-feedback-render-worker.cjs', 'dist-electron/canvas-feedback-render-worker.cjs');
await cp('../runtime-host/bundle/official-docs', 'dist-electron/official-docs', { recursive: true });
await cp('../runtime-host/bundle/product-replacement-helper.cjs', 'dist-electron/product-replacement-helper.cjs');

if (withSourcemap) {
  await cp('../runtime-host/bundle/runtime-host.cjs.map', 'dist-electron/runtime-host.cjs.map');
  await cp('../runtime-host/bundle/canvas-feedback-render-worker.cjs.map', 'dist-electron/canvas-feedback-render-worker.cjs.map');
  await cp('../runtime-host/bundle/product-replacement-helper.cjs.map', 'dist-electron/product-replacement-helper.cjs.map');
}

if (!skipWebDist) {
  await cp('../web/dist', 'dist', { recursive: true });
}

await packageDebruteCliRuntimePayload({
  outDir: 'dist-electron/runtime-product/cli'
});
await cp(join(workspaceRoot, 'skills'), 'dist-electron/runtime-product/skills', { recursive: true });
await mkdir('dist-electron/runtime-product', { recursive: true });
const productVersion = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')).version;
await writeFile('dist-electron/runtime-product/product-manifest.json', `${JSON.stringify({
  schemaVersion: 1,
  productVersion
}, null, 2)}\n`, 'utf8');

await cp('build/icon.svg', 'dist-electron/icon.svg');
await cp('build/icon.png', 'dist-electron/icon.png');
await cp('build/dock_icon.png', 'dist-electron/dock_icon.png');
await cp('build/tray_icon.png', 'dist-electron/tray_icon.png');
await cp('build/tray_icon_template.png', 'dist-electron/tray_icon_template.png');
await cp('build/tray_icon_template@2x.png', 'dist-electron/tray_icon_template@2x.png');
await Promise.all(['starting', 'running', 'degraded', 'stopped', 'error'].map((status) => (
  cp(`build/tray_icon_${status}.png`, `dist-electron/tray_icon_${status}.png`)
)));
