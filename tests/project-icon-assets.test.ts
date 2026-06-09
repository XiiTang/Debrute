import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syncProjectIcons } from '../scripts/sync-project-icons.mjs';

describe('project icon assets', () => {
  it('syncs the canonical project icon to Web and Electron consumer paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-project-icon-'));
    await mkdir(join(root, 'assets/project-icon'), { recursive: true });
    await mkdir(join(root, 'apps/web'), { recursive: true });
    await mkdir(join(root, 'apps/desktop'), { recursive: true });

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"></svg>';
    await writeFile(join(root, 'assets/project-icon/debrute.svg'), svg, 'utf8');

    await syncProjectIcons({ root });

    await expect(readFile(join(root, 'apps/web/public/debrute.svg'), 'utf8')).resolves.toBe(svg);
    await expect(readFile(join(root, 'apps/desktop/build/icon.svg'), 'utf8')).resolves.toBe(svg);
    const desktopPng = await readFile(join(root, 'apps/desktop/build/icon.png'));
    expect(desktopPng.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('fails when the canonical project icon is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-project-icon-missing-'));

    await expect(syncProjectIcons({ root })).rejects.toThrow('Missing canonical project icon');
  });

  it('wires the project icon into Web and Electron consumers', () => {
    const root = process.cwd();
    const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const desktopPackage = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')) as {
      build: { icon: string };
    };
    const webHtml = readFileSync(join(root, 'apps/web/index.html'), 'utf8');
    const electronMain = readFileSync(join(root, 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(rootPackage.scripts['icons:sync']).toBe('node scripts/sync-project-icons.mjs');
    expect(webHtml).toContain('<link rel="icon" type="image/svg+xml" href="/debrute.svg" />');
    expect(desktopPackage.build.icon).toBe('build/icon.png');
    expect(electronMain).toContain("const projectIconPath = join(__dirname, 'icon.png')");
    expect(electronMain).toContain('icon: projectIconPath');
    expect(electronMain).toContain('app.dock.setIcon(projectIconPath)');
  });
});
