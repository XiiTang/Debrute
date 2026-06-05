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

    expect(desktopPackage.scripts['build:electron']).toBe('node scripts/bundle-electron.mjs');
    expect(desktopPackage.scripts['build:electron:dev']).toBe('node scripts/bundle-electron.mjs --skip-web-dist');
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
});
