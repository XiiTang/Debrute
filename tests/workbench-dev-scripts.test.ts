import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  scripts: Record<string, string>;
}

describe('Workbench development scripts', () => {
  it('routes root pnpm dev through the registry-aware script', () => {
    const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as PackageJson;

    expect(rootPackage.scripts.dev).toBe('tsx scripts/dev-workbench.ts');
  });

  it('does not require fixed Electron development ports', () => {
    const desktopPackage = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8')) as PackageJson;

    expect(desktopPackage.scripts['dev:electron']).toBe('tsx ../../scripts/dev-electron-workbench.ts');
  });
});
