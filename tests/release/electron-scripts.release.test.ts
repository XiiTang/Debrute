import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  scripts: Record<string, string>;
}

describe('Electron development scripts', () => {
  it('does not require a production web dist before starting the Vite dev server', () => {
    const desktopPackage = JSON.parse(
      readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8')
    ) as PackageJson;

    expect(desktopPackage.scripts['build:electron']).toBe('node ../../scripts/run-cargo-with-native-raster.mjs -- build -p debrute-runtime --release --bins && node scripts/bundle-electron.mjs');
    expect(desktopPackage.scripts['build:electron:dev']).toBe('node scripts/bundle-electron.mjs --skip-web-dist');
    expect(desktopPackage.scripts['build:electron']).not.toContain('icons:sync');
    expect(desktopPackage.scripts['build:electron:dev']).not.toContain('icons:sync');
    expect(desktopPackage.scripts['dev:electron']).toBe('tsx ../../scripts/dev-electron-workbench.ts');
    expect(desktopPackage.scripts['dev:electron']).not.toContain('pnpm build:electron &&');
  });

  it('builds or reuses the Rust Runtime and keeps Vite frontend-only', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/dev-electron-workbench.ts'), 'utf8');

    expect(script).toContain('buildRustRuntime');
    expect(script).toContain('ensureRustRuntime');
    expect(script).toContain('registerDevWorkbenchOrigin');
    expect(script).toContain("'@debrute/web'");
    expect(script).toContain('DEBRUTE_RUNTIME_ORIGIN: registration.runtime_origin');
  });

  it('uses the native Control handshake instead of runtime state files', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/dev-electron-workbench.ts'), 'utf8');
    const runtimeDev = readFileSync(join(process.cwd(), 'scripts/rust-runtime-dev.ts'), 'utf8');

    expect(runtimeDev).toContain("role: 'launcher'");
    expect(runtimeDev).toContain('connectRuntimeControl');
  });

  it('launches Electron only after Vite is ready and lets the promoted host request window tickets', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/dev-electron-workbench.ts'), 'utf8');
    const adapter = readFileSync(
      join(process.cwd(), 'apps/desktop/src/electron/desktopWindowControlAdapter.ts'),
      'utf8'
    );

    expect(script.indexOf('await waitForVite(viteOrigin)')).toBeLessThan(
      script.indexOf('electron = spawn(electronEntrypoint')
    );
    expect(adapter).toContain('createDesktopLaunchTicket(windowKey)');
  });

  it('ad-hoc signs the unpacked development Electron app when macOS rejects its downloaded signature', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/dev-electron-workbench.ts'), 'utf8');

    expect(script).toContain('ensureDevelopmentElectronIsSigned();');
    expect(script).toContain("'build/entitlements.mac.plist'");
    expect(script).toContain("'build/entitlements.mac.inherit.plist'");
    expect(script).toContain("spawnSync('/usr/bin/codesign'");
  });

  it('owns all Desktop windows in one Electron application instance', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('app.requestSingleInstanceLock()');
    expect(main).toContain("app.on('second-instance'");
    expect(main).toContain("app.on('window-all-closed'");
  });

  it('stops only Electron and Vite and leaves the shared Runtime alive', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/dev-electron-workbench.ts'), 'utf8');

    expect(script).toContain('Promise.all([stopChild(electron), stopChild(vite)])');
  });

  it('keeps native Electron runtime modules external so their native packages resolve from pnpm', () => {
    const script = readFileSync(join(process.cwd(), 'apps/desktop/scripts/bundle-electron.mjs'), 'utf8');

    expect(script).toContain("external: ['electron']");
  });

  it('targets Node.js 24 for Electron main and preload bundles', () => {
    const script = readFileSync(join(process.cwd(), 'apps/desktop/scripts/bundle-electron.mjs'), 'utf8');

    expect(script).toContain("target: 'node24'");
  });

  it('copies Desktop window and dock icons without a Desktop tray icon', () => {
    const script = readFileSync(join(process.cwd(), 'apps/desktop/scripts/bundle-electron.mjs'), 'utf8');

    expect(script).toContain("await cp('build/icon.svg', 'dist-electron/icon.svg')");
    expect(script).toContain("await cp('build/icon.png', 'dist-electron/icon.png')");
    expect(script).toContain("await cp('build/dock_icon.png', 'dist-electron/dock_icon.png')");
    expect(script).not.toContain('tray_icon');
  });

});
