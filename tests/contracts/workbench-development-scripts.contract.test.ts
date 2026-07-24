import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  scripts: Record<string, string>;
}

describe('Workbench development scripts', () => {
  it('routes root pnpm dev through the registry-aware script', () => {
    const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as PackageJson;

    expect(rootPackage.scripts.dev).toBe('tsx --tsconfig tsconfig.base.json scripts/dev-workbench.ts');
    const source = readFileSync(join(process.cwd(), 'scripts/dev-workbench.ts'), 'utf8');
    expect(source).toContain("process.env.DEBRUTE_DEV_NO_OPEN === '1'");
    expect(source).toContain('restartExisting: runtimeRebuilt');
    expect(source).toContain('control.registerDevWorkbenchOrigin(viteOrigin)');
    expectCanvasPerfStartupWiring(source);
    const runtimeSource = readFileSync(join(process.cwd(), 'scripts/rust-runtime-dev.ts'), 'utf8');
    expect(runtimeSource).toContain('const inspection = await existing.inspect();');
    expect(runtimeSource).toContain('inspection.executable_identity === currentExecutableIdentity');
    expect(runtimeSource).toContain('await waitForRuntimeReady(existing);');
    expect(runtimeSource).toContain('await waitForRuntimeReady(control);');
    expect(runtimeSource).toContain('await signMacosRuntimeApplication();');
    expect(runtimeSource).toContain("spawn('/usr/bin/codesign'");
  });

  it('does not require fixed Electron development ports', () => {
    const desktopPackage = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8')) as PackageJson;

    expect(desktopPackage.scripts['dev:electron']).toBe('tsx ../../scripts/dev-electron-workbench.ts');
    const source = readFileSync(join(process.cwd(), 'scripts/dev-electron-workbench.ts'), 'utf8');
    expect(source).toContain('control.registerDevWorkbenchOrigin(viteOrigin)');
    expect(source).toContain('const VITE_STARTUP_TIMEOUT_MS = 60_000');
    expect(source).toContain('finally {\n  await requestShutdown();\n}');
    expectCanvasPerfStartupWiring(source);
  });

  it('releases the previous Workbench connection when Vite replaces the application module', () => {
    const source = readFileSync(
      join(process.cwd(), 'apps/web/src/workbench/WorkbenchApp.tsx'),
      'utf8'
    );

    expect(source).toContain('import.meta.hot.dispose(() => api.dispose())');
  });

  it('isolates real browser verification from an already-running developer Runtime', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/verify-workbench-browser.mjs'), 'utf8');

    expect(source).toContain('TMPDIR: fixtureTemporaryDirectory');
    expect(source).toContain("DEBRUTE_DEV_NO_OPEN: '1'");
    expect(source).toContain("DEBRUTE_DEV_STOP_RUNTIME_ON_EXIT: '1'");
    expect(source).toContain('await stopIsolatedRuntime();');
    expect(source).toContain('temporaryDirectory: fixtureTemporaryDirectory');
    expect(source).toContain('await ensureChildProcessGroupStopped(child.pid);');
  });
});

function expectCanvasPerfStartupWiring(source: string): void {
  expect(source).toContain('parseWorkbenchDevelopmentOptions(process.argv.slice(2))');
  expect(source).toContain('VITE_DEBRUTE_CANVAS_PERF: developmentOptions.canvasPerfEnabled');
  expect(source).toContain('Canvas performance probe: ${developmentOptions.canvasPerfEnabled');
}
