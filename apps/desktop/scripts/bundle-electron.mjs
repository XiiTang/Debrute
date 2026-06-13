import { execFileSync } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const skipWebDist = process.argv.includes('--skip-web-dist');

execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', '@debrute/runtime-host', 'build'], {
  cwd: '../..',
  stdio: 'inherit'
});

await rm('dist-electron', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
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
await cp('../runtime-host/bundle/runtime-host.cjs.map', 'dist-electron/runtime-host.cjs.map');
await cp('../runtime-host/bundle/official-docs', 'dist-electron/official-docs', { recursive: true });

if (!skipWebDist) {
  await cp('../web/dist', 'dist', { recursive: true });
}

await cp('build/icon.svg', 'dist-electron/icon.svg');
await cp('build/icon.png', 'dist-electron/icon.png');
await cp('build/dock_icon.png', 'dist-electron/dock_icon.png');
await cp('build/tray_icon.png', 'dist-electron/tray_icon.png');
await Promise.all(['starting', 'running', 'degraded', 'stopped', 'error'].map((status) => (
  cp(`build/tray_icon_${status}.png`, `dist-electron/tray_icon_${status}.png`)
)));
