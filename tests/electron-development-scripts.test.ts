import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { nodePtyRuntimePayloadEntries } from '../scripts/node-pty-runtime-payload.mjs';

interface PackageJson {
  scripts: Record<string, string>;
  build: {
    electronVersion: string;
  };
  devDependencies: Record<string, string>;
}

describe('Electron development scripts', () => {
  it('does not require a production web dist before starting the Vite dev server', () => {
    const desktopPackage = JSON.parse(
      readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8')
    ) as PackageJson;

    expect(desktopPackage.scripts['build:electron']).toBe('node scripts/bundle-electron.mjs');
    expect(desktopPackage.scripts['build:electron:dev']).toBe('node scripts/bundle-electron.mjs --skip-web-dist');
    expect(desktopPackage.scripts['build:electron']).not.toContain('icons:sync');
    expect(desktopPackage.scripts['build:electron:dev']).not.toContain('icons:sync');
    expect(desktopPackage.scripts['dev:electron']).toBe('tsx ../../scripts/dev-electron-workbench.ts');
    expect(desktopPackage.scripts['dev:electron']).not.toContain('pnpm build:electron &&');
  });

  it('starts Electron development runtimes as external daemon/web processes and launches Electron attached', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/dev-electron-workbench.ts'), 'utf8');

    expect(script).toContain("'@debrute/daemon'");
    expect(script).toContain("'@debrute/web'");
    expect(script).not.toContain('DEBRUTE_WORKBENCH_RUNTIME_MODE');
    expect(script).not.toContain('DEBRUTE_WEB_URL');
    expect(script).not.toContain('DEBRUTE_DAEMON_TOKEN:');
    expect(script).not.toContain('pid ?? process.pid');
  });

  it('does not attach Electron development to an older CLI/source-dev runtime', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/dev-electron-workbench.ts'), 'utf8');

    expect(script).toContain('isDesktopDevRuntimeForCurrentSession');
    expect(script).toContain("state.runtimeKind === 'desktop-dev'");
    expect(script).toContain("state.owner.kind === 'dev'");
    expect(script).toContain('state.owner.ownerId === ownerId');
    expect(script).toContain('isWorkbenchRuntimeHealthy(state)');
  });

  it('launches Electron only after the development runtime is registered', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/dev-electron-workbench.ts'), 'utf8');

    expect(script.indexOf('const result = await ensureRegisteredWorkbenchRuntime')).toBeLessThan(
      script.indexOf('electron = launchElectron();')
    );
    expect(script).not.toContain('currentElectronChild');
  });

  it('stops Electron before stopping the external development runtime', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/dev-electron-workbench.ts'), 'utf8');

    expect(script).toContain('let shutdownPromise: Promise<void> | undefined;');
    expect(script).toContain('shutdownPromise ??= shutdown(currentRuntimeState, deleteOwnState);');
    expect(script).toContain("process.once('exit', () => {");
    expect(script).toContain('deleteOwnRuntimeStateSync();');
    expect(script).toContain('await stopElectron(electron)');
    expect(script).toContain('await stopRuntimeChildren();');
    expect(script.indexOf('await stopElectron(electron)')).toBeLessThan(script.indexOf('await stopRuntimeChildren();'));
    expect(script).not.toContain('killChildren();');
  });

  it('explains duplicate Electron instances before quitting the dev launch', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('Debrute desktop is already running.');
    expect(main).toContain('pnpm dev:electron');
    expect(main.indexOf('console.error(')).toBeLessThan(main.indexOf('app.quit();'));
  });

  it('maps process termination signals to true Electron quit', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain("for (const signal of ['SIGINT', 'SIGTERM'] as const)");
    expect(main).toContain('process.once(signal, () => {');
    expect(main).toContain('detachProjectWindowLeasesFromStoppedRuntime();');
    expect(main).toContain('void requestTrueQuit();');
    expect(main.indexOf('detachProjectWindowLeasesFromStoppedRuntime();')).toBeLessThan(
      main.indexOf('void requestTrueQuit();')
    );
  });

  it('does not report project-window lease release failures during true quit', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('if (trueQuitRequested) {');
    expect(main.indexOf('if (trueQuitRequested) {')).toBeLessThan(
      main.indexOf('Debrute Electron window lease release failed')
    );
  });

  it('does not show a newly created Electron window until Workbench navigation succeeds', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('show: false');
    expect(main).toContain('await revealLoadedWorkbenchWindow(window, async () => {');
    expect(main).toContain('window.show();');
    expect(main).toContain('window.destroy();');
    expect(main.indexOf('show: false')).toBeLessThan(
      main.indexOf('await revealLoadedWorkbenchWindow(window, async () => {')
    );
    expect(main.indexOf('await revealLoadedWorkbenchWindow(window, async () => {')).toBeLessThan(
      main.indexOf('window.show();')
    );
  });

  it('keeps native Electron runtime modules external so their native packages resolve from pnpm', () => {
    const script = readFileSync(join(process.cwd(), 'apps/desktop/scripts/bundle-electron.mjs'), 'utf8');

    expect(script).toContain("external: ['electron', 'node-pty', 'sharp']");
  });

  it('loads app-server terminal pty code after Electron CJS bundling', async () => {
    const root = mkdtempSync(join(tmpdir(), `debrute-electron-cjs-pty-${process.pid}-`));
    try {
      mkdirSync(join(root, 'node_modules/node-pty'), { recursive: true });
      writeFileSync(
        join(root, 'node_modules/node-pty/index.js'),
        "exports.spawn = () => { throw new Error('node-pty stub should not spawn'); };\n"
      );
      writeFileSync(join(root, 'node_modules/node-pty/package.json'), '{"name":"node-pty","main":"index.js"}');

      const entry = join(root, 'entry.ts');
      const outfile = join(root, 'out.cjs');
      writeFileSync(
        entry,
        `import { ensureNodePtySpawnHelperExecutable } from ${JSON.stringify(join(process.cwd(), 'apps/app-server/src/terminal/NodePtyTerminalPty.ts'))};\n`
        + `ensureNodePtySpawnHelperExecutable({ packageRoot: ${JSON.stringify(root)}, platform: 'darwin', arch: 'arm64' });\n`
      );

      await build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
        external: ['node-pty'],
        logOverride: {
          'empty-import-meta': 'silent'
        }
      });

      execFileSync(process.execPath, [outfile], { stdio: 'pipe' });
      expect(readFileSync(outfile, 'utf8')).not.toMatch(/createRequire\)\(import_meta\d*\.url\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('packages only the target node-pty runtime payload for Electron', () => {
    const script = readFileSync(join(process.cwd(), 'apps/desktop/scripts/package-sharp-runtime.mjs'), 'utf8');

    expect(script).toContain('nodePtyRuntimePayloadEntries');
    expect(script).not.toContain("await cp(packageRoot, destination, { recursive: true, dereference: true });");
  });

  it('filters node-pty lib payload to runtime JavaScript files', async () => {
    const root = join(tmpdir(), `debrute-node-pty-payload-${process.pid}-${Date.now()}`);
    const packageRoot = join(root, 'node_modules', 'node-pty');
    mkdirSync(join(packageRoot, 'lib', 'shared'), { recursive: true });
    mkdirSync(join(packageRoot, 'prebuilds', 'darwin-arm64'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), '{}');
    writeFileSync(join(packageRoot, 'lib', 'index.js'), '');
    writeFileSync(join(packageRoot, 'lib', 'index.js.map'), '');
    writeFileSync(join(packageRoot, 'lib', 'terminal.test.js'), '');
    writeFileSync(join(packageRoot, 'lib', 'shared', 'conout.js'), '');
    writeFileSync(join(packageRoot, 'lib', 'windowsTerminal.js'), '');
    writeFileSync(join(packageRoot, 'prebuilds', 'darwin-arm64', 'pty.node'), '');
    writeFileSync(join(packageRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'), '');
    writeFileSync(join(packageRoot, 'prebuilds', 'darwin-arm64', 'pty.pdb'), '');
    try {
      const entries = nodePtyRuntimePayloadEntries(root, { id: 'darwin-arm64' });
      const libEntry = entries.find((entry) => entry.to === 'node_modules/node-pty/lib');
      const prebuildEntry = entries.find((entry) => entry.to === 'node_modules/node-pty/prebuilds/darwin-arm64');

      expect(libEntry?.filter?.(join(packageRoot, 'lib'))).toBe(true);
      expect(libEntry?.filter?.(join(packageRoot, 'lib', 'index.js'))).toBe(true);
      expect(libEntry?.filter?.(join(packageRoot, 'lib', 'shared', 'conout.js'))).toBe(false);
      expect(libEntry?.filter?.(join(packageRoot, 'lib', 'terminal.test.js'))).toBe(false);
      expect(libEntry?.filter?.(join(packageRoot, 'lib', 'index.js.map'))).toBe(false);
      expect(libEntry?.filter?.(join(packageRoot, 'lib', 'windowsTerminal.js'))).toBe(false);
      expect(prebuildEntry?.filter?.(join(packageRoot, 'prebuilds', 'darwin-arm64', 'pty.node'))).toBe(true);
      expect(prebuildEntry?.filter?.(join(packageRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'))).toBe(true);
      expect(prebuildEntry?.filter?.(join(packageRoot, 'prebuilds', 'darwin-arm64', 'pty.pdb'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not require a Linux node-pty spawn helper for Electron when node-pty did not build one', async () => {
    const root = join(tmpdir(), `debrute-node-pty-linux-payload-${process.pid}-${Date.now()}`);
    const packageRoot = join(root, 'node_modules', 'node-pty');
    mkdirSync(join(packageRoot, 'lib'), { recursive: true });
    mkdirSync(join(packageRoot, 'build/Release'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), '{}');
    writeFileSync(join(packageRoot, 'lib', 'index.js'), '');
    writeFileSync(join(packageRoot, 'build/Release', 'pty.node'), '');
    try {
      const entries = nodePtyRuntimePayloadEntries(root, { id: 'linux-x64' });

      expect(entries.map((entry) => entry.to)).toContain('node_modules/node-pty/build/Release/pty.node');
      expect(entries.map((entry) => entry.to)).not.toContain('node_modules/node-pty/build/Release/spawn-helper');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('targets Node.js 24 for Electron main and preload bundles', () => {
    const script = readFileSync(join(process.cwd(), 'apps/desktop/scripts/bundle-electron.mjs'), 'utf8');

    expect(script).toContain("target: 'node24'");
    expect(script).not.toContain("target: 'node22'");
  });

  it('copies the project icon into the Electron runtime bundle', () => {
    const script = readFileSync(join(process.cwd(), 'apps/desktop/scripts/bundle-electron.mjs'), 'utf8');

    expect(script).toContain("await cp('build/icon.svg', 'dist-electron/icon.svg')");
    expect(script).toContain("await cp('build/icon.png', 'dist-electron/icon.png')");
    expect(script).toContain("await cp('build/dock_icon.png', 'dist-electron/dock_icon.png')");
    expect(script).toContain("await cp('build/tray_icon.png', 'dist-electron/tray_icon.png')");
  });

  it('runs Electron main and preload bundles on embedded Node.js 24', () => {
    const root = process.cwd();
    const desktopPackage = JSON.parse(
      readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')
    ) as PackageJson;
    const desktopRequire = createRequire(join(root, 'apps/desktop/package.json'));
    const electronPackageDir = dirname(desktopRequire.resolve('electron/package.json'));
    const electronPathFile = join(electronPackageDir, 'path.txt');
    if (!existsSync(electronPathFile)) {
      execFileSync(process.execPath, [join(electronPackageDir, 'install.js')], { stdio: 'inherit' });
    }
    if (!existsSync(electronPathFile) && process.env.GITHUB_ACTIONS === 'true') {
      expect(desktopPackage.build.electronVersion).toBe(desktopPackage.devDependencies.electron);
      return;
    }
    const electronExecutable = join(electronPackageDir, 'dist', readFileSync(electronPathFile, 'utf8'));
    const embeddedNodeVersion = execFileSync(electronExecutable, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      }
    }).trim();

    expect(desktopPackage.build.electronVersion).toBe(desktopPackage.devDependencies.electron);
    expect(embeddedNodeVersion).toMatch(/^24\./);
  }, 60_000);
});
