import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { syncProjectIcons } from '../scripts/sync-project-icons.mjs';

describe('project icon assets', () => {
  it('generates the complete project icon asset matrix from the canonical SVG', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-project-icon-'));
    await mkdir(join(root, 'assets/project-icon'), { recursive: true });
    await mkdir(join(root, 'apps/web'), { recursive: true });
    await mkdir(join(root, 'apps/desktop'), { recursive: true });

    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">',
      '<path d="M0 0 H1024 V1024 H0 Z" fill="#08090C"/>',
      '<circle cx="512" cy="512" r="300" fill="#F3E3C0"/>',
      '</svg>'
    ].join('');
    await writeFile(join(root, 'assets/project-icon/debrute.svg'), svg, 'utf8');

    const result = await syncProjectIcons({ root });

    await expect(readFile(join(root, 'apps/web/public/debrute.svg'), 'utf8')).resolves.toBe(svg);
    await expect(readFile(join(root, 'apps/desktop/build/icon.svg'), 'utf8')).resolves.toBe(svg);
    expect(result.targets.map((target) => target.replace(`${root}/`, '')).sort()).toEqual([
      'apps/desktop/build/icon.icns',
      'apps/desktop/build/icon.ico',
      'apps/desktop/build/icon.png',
      'apps/desktop/build/icon.svg',
      'apps/desktop/build/icons/1024x1024.png',
      'apps/desktop/build/icons/128x128.png',
      'apps/desktop/build/icons/16x16.png',
      'apps/desktop/build/icons/24x24.png',
      'apps/desktop/build/icons/256x256.png',
      'apps/desktop/build/icons/32x32.png',
      'apps/desktop/build/icons/48x48.png',
      'apps/desktop/build/icons/512x512.png',
      'apps/desktop/build/icons/64x64.png',
      'apps/desktop/build/logo.png',
      'apps/desktop/build/tray_icon.png',
      'apps/web/public/debrute.svg'
    ]);

    await expectPngDimensions(join(root, 'apps/desktop/build/logo.png'), 1024, 1024);
    await expectPngDimensions(join(root, 'apps/desktop/build/icon.png'), 1024, 1024);
    await expectPngDimensions(join(root, 'apps/desktop/build/tray_icon.png'), 66, 66);
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
      await expectPngDimensions(join(root, `apps/desktop/build/icons/${size}x${size}.png`), size, size);
      expect(await alphaAt(join(root, `apps/desktop/build/icons/${size}x${size}.png`), 0, 0)).toBe(0);
    }

    expect(await alphaAt(join(root, 'apps/desktop/build/logo.png'), 0, 0)).toBe(255);
    expect(await alphaAt(join(root, 'apps/desktop/build/icon.png'), 0, 0)).toBe(0);
    expect(await alphaAt(join(root, 'apps/desktop/build/icon.png'), 512, 512)).toBeGreaterThan(0);
    expect(await alphaAt(join(root, 'apps/desktop/build/tray_icon.png'), 0, 0)).toBe(0);
    expect(await alphaAt(join(root, 'apps/desktop/build/tray_icon.png'), 33, 33)).toBeGreaterThan(0);

    const icns = await readFile(join(root, 'apps/desktop/build/icon.icns'));
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
    const ico = await readFile(join(root, 'apps/desktop/build/icon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(4);
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

async function expectPngDimensions(path: string, width: number, height: number): Promise<void> {
  const metadata = await sharp(path).metadata();
  expect(metadata.format).toBe('png');
  expect(metadata.width).toBe(width);
  expect(metadata.height).toBe(height);
}

async function alphaAt(path: string, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * info.channels + 3];
}
