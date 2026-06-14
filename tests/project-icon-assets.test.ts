import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
      'apps/desktop/build/dock_icon.png',
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
      'apps/desktop/build/tray_icon_degraded.png',
      'apps/desktop/build/tray_icon_error.png',
      'apps/desktop/build/tray_icon_running.png',
      'apps/desktop/build/tray_icon_starting.png',
      'apps/desktop/build/tray_icon_stopped.png',
      'apps/desktop/build/tray_icon_template.png',
      'apps/desktop/build/tray_icon_template@2x.png',
      'apps/web/public/debrute.svg'
    ]);

    await expectPngDimensions(join(root, 'apps/desktop/build/logo.png'), 1024, 1024);
    await expectPngDimensions(join(root, 'apps/desktop/build/dock_icon.png'), 1024, 1024);
    await expectPngDimensions(join(root, 'apps/desktop/build/icon.png'), 1024, 1024);
    await expectPngDimensions(join(root, 'apps/desktop/build/tray_icon.png'), 66, 66);
    await expectPngDimensions(join(root, 'apps/desktop/build/tray_icon_template.png'), 18, 18);
    await expectPngDimensions(join(root, 'apps/desktop/build/tray_icon_template@2x.png'), 36, 36);
    for (const status of ['starting', 'running', 'degraded', 'stopped', 'error']) {
      await expectPngDimensions(join(root, `apps/desktop/build/tray_icon_${status}.png`), 66, 66);
      expect(await alphaAt(join(root, `apps/desktop/build/tray_icon_${status}.png`), 53, 53)).toBeGreaterThan(0);
    }
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
      await expectPngDimensions(join(root, `apps/desktop/build/icons/${size}x${size}.png`), size, size);
      expect(await alphaAt(join(root, `apps/desktop/build/icons/${size}x${size}.png`), 0, 0)).toBe(0);
    }

    expect(await alphaAt(join(root, 'apps/desktop/build/logo.png'), 0, 0)).toBe(255);
    expect(await alphaAt(join(root, 'apps/desktop/build/icon.png'), 0, 0)).toBe(0);
    expect(await alphaAt(join(root, 'apps/desktop/build/icon.png'), 512, 512)).toBeGreaterThan(0);
    expect(await alphaEdgeMargins(join(root, 'apps/desktop/build/icon.png'))).toEqual({
      left: 82,
      top: 82,
      right: 82,
      bottom: 82
    });
    expect(await alphaEdgeMargins(join(root, 'apps/desktop/build/dock_icon.png'))).toEqual({
      left: 102,
      top: 102,
      right: 102,
      bottom: 102
    });
    expect(await alphaAt(join(root, 'apps/desktop/build/dock_icon.png'), 0, 0)).toBe(0);
    expect(await alphaAt(join(root, 'apps/desktop/build/dock_icon.png'), 0, 512)).toBe(0);
    expect(await alphaAt(join(root, 'apps/desktop/build/dock_icon.png'), 512, 0)).toBe(0);
    expect(await firstOpaqueXAtY(join(root, 'apps/desktop/build/dock_icon.png'), 102)).toBe(253);
    expect(await firstOpaqueXAtY(join(root, 'apps/desktop/build/dock_icon.png'), 114)).toBe(203);
    expect(await firstOpaqueXAtY(join(root, 'apps/desktop/build/dock_icon.png'), 159)).toBe(141);
    expect(await firstOpaqueXAtY(join(root, 'apps/desktop/build/dock_icon.png'), 358)).toBe(102);
    expect(await firstOpaqueXAtY(join(root, 'apps/desktop/build/dock_icon.png'), 512)).toBe(102);
    expect(await dockAlphaCoverage(join(root, 'apps/desktop/build/dock_icon.png'))).toBeCloseTo(0.635, 2);
    expect(await darkPixelCoverage(join(root, 'apps/desktop/build/dock_icon.png'))).toBeLessThan(0.3);
    expect(await brightPixelCoverage(join(root, 'apps/desktop/build/dock_icon.png'))).toBeGreaterThan(0.35);
    expect(await alphaAt(join(root, 'apps/desktop/build/tray_icon.png'), 0, 0)).toBe(0);
    expect(await alphaAt(join(root, 'apps/desktop/build/tray_icon.png'), 33, 33)).toBeGreaterThan(0);
    expect(await alphaEdgeMargins(join(root, 'apps/desktop/build/tray_icon.png'))).toEqual({
      left: 3,
      top: 3,
      right: 3,
      bottom: 3
    });
    expect(await alphaAt(join(root, 'apps/desktop/build/tray_icon_template.png'), 0, 0)).toBe(0);
    expect(await alphaAt(join(root, 'apps/desktop/build/tray_icon_template.png'), 9, 9)).toBeGreaterThan(0);
    expect(await alphaEdgeMargins(join(root, 'apps/desktop/build/tray_icon_template.png'))).toEqual({
      left: 1,
      top: 1,
      right: 1,
      bottom: 1
    });
    expect(await alphaEdgeMargins(join(root, 'apps/desktop/build/tray_icon_template@2x.png'))).toEqual({
      left: 2,
      top: 2,
      right: 2,
      bottom: 2
    });
    expect(await coloredOpaquePixelCoverage(join(root, 'apps/desktop/build/tray_icon_template.png'))).toBe(0);
    expect(await brightOpaquePixelCoverage(join(root, 'apps/desktop/build/tray_icon_template.png'))).toBeGreaterThan(0.2);

    const icns = await readFile(join(root, 'apps/desktop/build/icon.icns'));
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
    const ico = await readFile(join(root, 'apps/desktop/build/icon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(4);
  }, 15_000);

  it('fails when the canonical project icon is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-project-icon-missing-'));

    await expect(syncProjectIcons({ root })).rejects.toThrow('Missing canonical project icon');
  });

  it('keeps generated desktop icon build resources available to Git', () => {
    for (const asset of [
      'apps/desktop/build/dock_icon.png',
      'apps/desktop/build/icon.png',
      'apps/desktop/build/icon.icns',
      'apps/desktop/build/icons/1024x1024.png',
      'apps/desktop/build/tray_icon.png',
      'apps/desktop/build/tray_icon_template@2x.png',
      'apps/desktop/build/tray_icon_template.png',
      'apps/desktop/build/tray_icon_starting.png',
      'apps/desktop/build/tray_icon_running.png',
      'apps/desktop/build/tray_icon_degraded.png',
      'apps/desktop/build/tray_icon_stopped.png',
      'apps/desktop/build/tray_icon_error.png'
    ]) {
      const result = spawnSync('git', ['check-ignore', '-q', asset], { cwd: process.cwd() });
      expect(result.status, asset).toBe(1);
    }
  });

  it('wires the project icon into Web and Electron consumers', () => {
    const root = process.cwd();
    const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const desktopPackage = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')) as {
      build: { icon?: string; directories: { buildResources: string } };
    };
    const webHtml = readFileSync(join(root, 'apps/web/index.html'), 'utf8');
    const electronMain = readFileSync(join(root, 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(rootPackage.scripts['icons:sync']).toBe('node scripts/sync-project-icons.mjs');
    expect(webHtml).toContain('<link rel="icon" type="image/svg+xml" href="/debrute.svg" />');
    expect(desktopPackage.build.directories.buildResources).toBe('build');
    expect(desktopPackage.build).not.toHaveProperty('icon');
    expect(electronMain).toContain("const projectIconPath = join(__dirname, 'icon.png')");
    expect(electronMain).toContain("const dockIconPath = join(__dirname, 'dock_icon.png')");
    expect(electronMain).toContain('icon: projectIconPath');
    expect(electronMain).toContain('app.dock!.setIcon(dockIconPath)');
    expect(electronMain).toContain('nativeImage: electron.nativeImage');
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

async function alphaEdgeMargins(path: string): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alpha = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
  const hasAlphaInColumn = (x: number) => {
    for (let y = 0; y < info.height; y += 1) {
      if (alpha(x, y) > 0) return true;
    }
    return false;
  };
  const hasAlphaInRow = (y: number) => {
    for (let x = 0; x < info.width; x += 1) {
      if (alpha(x, y) > 0) return true;
    }
    return false;
  };
  let left = 0;
  while (left < info.width && !hasAlphaInColumn(left)) left += 1;
  let right = 0;
  while (right < info.width && !hasAlphaInColumn(info.width - 1 - right)) right += 1;
  let top = 0;
  while (top < info.height && !hasAlphaInRow(top)) top += 1;
  let bottom = 0;
  while (bottom < info.height && !hasAlphaInRow(info.height - 1 - bottom)) bottom += 1;
  return { left, top, right, bottom };
}

async function firstOpaqueXAtY(path: string, y: number): Promise<number> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let x = 0; x < info.width; x += 1) {
    if (data[(y * info.width + x) * info.channels + 3] > 0) {
      return x;
    }
  }
  return -1;
}

async function dockAlphaCoverage(path: string): Promise<number> {
  const { data, info } = await sharp(path)
    .resize(128, 128)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let pixels = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * info.channels + 3] > 16) {
        pixels += 1;
      }
    }
  }
  return pixels / (info.width * info.height);
}

async function darkPixelCoverage(path: string): Promise<number> {
  return luminanceCoverage(path, (luminance) => luminance < 45);
}

async function brightPixelCoverage(path: string): Promise<number> {
  return luminanceCoverage(path, (luminance) => luminance > 170);
}

async function coloredOpaquePixelCoverage(path: string): Promise<number> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let opaquePixels = 0;
  let coloredPixels = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset + 3] === 0) continue;
      opaquePixels += 1;
      if (data[offset] !== data[offset + 1] || data[offset + 1] !== data[offset + 2]) {
        coloredPixels += 1;
      }
    }
  }
  return opaquePixels === 0 ? 0 : coloredPixels / opaquePixels;
}

async function brightOpaquePixelCoverage(path: string): Promise<number> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let brightPixels = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset + 3] === 0) continue;
      if (data[offset] > 240 && data[offset + 1] > 240 && data[offset + 2] > 240) {
        brightPixels += 1;
      }
    }
  }
  return brightPixels / (info.width * info.height);
}

async function luminanceCoverage(path: string, predicate: (luminance: number) => boolean): Promise<number> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let pixels = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset + 3] === 0) continue;
      const luminance = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
      if (predicate(luminance)) {
        pixels += 1;
      }
    }
  }
  return pixels / (info.width * info.height);
}
