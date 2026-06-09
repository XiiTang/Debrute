import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

    expect(desktopPackage.scripts['build:electron']).toBe('pnpm --workspace-root icons:sync && node scripts/bundle-electron.mjs');
    expect(desktopPackage.scripts['build:electron:dev']).toBe('pnpm --workspace-root icons:sync && node scripts/bundle-electron.mjs --skip-web-dist');
    expect(desktopPackage.scripts['dev:electron']).toBe('tsx ../../scripts/dev-electron-workbench.ts');
    expect(desktopPackage.scripts['dev:electron']).not.toContain('pnpm build:electron &&');
  });

  it('starts fresh Electron development runtimes in hosted mode and reused runtimes in attached mode', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/dev-electron-workbench.ts'), 'utf8');

    expect(script).toContain("DEBRUTE_WORKBENCH_RUNTIME_MODE: 'hosted'");
    expect(script).toContain("DEBRUTE_WORKBENCH_RUNTIME_MODE: 'attached'");
    expect(script).not.toContain('pid ?? process.pid');
  });

  it('keeps sharp external so its native optional packages resolve from pnpm', () => {
    const script = readFileSync(join(process.cwd(), 'apps/desktop/scripts/bundle-electron.mjs'), 'utf8');

    expect(script).toContain("external: ['electron', 'sharp']");
  });

  it('targets Node.js 24 for Electron main and preload bundles', () => {
    const script = readFileSync(join(process.cwd(), 'apps/desktop/scripts/bundle-electron.mjs'), 'utf8');

    expect(script).toContain("target: 'node24'");
    expect(script).not.toContain("target: 'node22'");
  });

  it('copies the project icon into the Electron runtime bundle', () => {
    const script = readFileSync(join(process.cwd(), 'apps/desktop/scripts/bundle-electron.mjs'), 'utf8');

    expect(script).toContain("await cp('build/icon.svg', 'dist-electron/icon.svg')");
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
