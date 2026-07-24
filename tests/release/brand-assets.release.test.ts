import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { syncBrandAssets } from '../../scripts/sync-brand-assets.mjs';

describe('brand assets', () => {
  it('preserves the approved complete-mascot silhouette in the canonical vector', async () => {
    const reference = join(process.cwd(), 'assets/brand/reference/debrute-mascot-approved.png');
    const canonical = join(process.cwd(), 'assets/brand/debrute-mascot.svg');
    const svg = await readFile(canonical, 'utf8');

    expect(svg).not.toMatch(/<image\b|data:image|(?:href|src)=["']https?:\/\//);
    expect(svg.match(/<g id="(?:paper|mascot)">/g)).toEqual([
      '<g id="paper">',
      '<g id="mascot">'
    ]);
    expect(await colorBlockIntersectionOverUnion(reference, canonical, 'ink')).toBeGreaterThan(0.965);
    expect(await colorBlockIntersectionOverUnion(reference, canonical, 'clay')).toBeGreaterThan(0.965);
    expect(await colorBlockIntersectionOverUnion(reference, canonical, 'clay', 0.62)).toBeGreaterThan(0.94);
    for (const featureBounds of [
      { left: 1060, top: 780, width: 230, height: 120 },
      { left: 810, top: 920, width: 110, height: 110 },
      { left: 1120, top: 900, width: 120, height: 120 },
      { left: 970, top: 970, width: 210, height: 210 },
      { left: 890, top: 1180, width: 270, height: 130 }
    ]) {
      expect(
        await colorBlockIntersectionOverUnion(reference, canonical, 'cream', 0, featureBounds),
        JSON.stringify(featureBounds)
      ).toBeGreaterThan(0.85);
    }
  });

  it('generates every complete-mascot product icon from the canonical SVG', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-brand-assets-'));
    await mkdir(join(root, 'assets/brand/materials'), { recursive: true });
    await mkdir(join(root, 'apps/web'), { recursive: true });
    await mkdir(join(root, 'apps/desktop'), { recursive: true });

    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 2048" data-mascot-bounds="424 448 1200 1160">',
      '<g id="paper"><rect width="2048" height="2048" fill="#F9E8D4"/></g>',
      '<g id="mascot">',
      '<path d="M424 620H1624V1420H424Z" fill="#282825"/>',
      '<path d="M760 448H1288V620H760Z" fill="#D76522"/>',
      '<path d="M820 1420H1228V1608H820Z" fill="#D76522"/>',
      '<circle cx="1024" cy="920" r="96" fill="#FFF0DC"/>',
      '</g>',
      '</svg>'
    ].join('');
    await writeFile(join(root, 'assets/brand/debrute-mascot.svg'), svg, 'utf8');
    await writeFile(
      join(root, 'assets/brand/materials/cut-large.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#fff" d="M0 0H100V100H0Z"/></svg>',
      'utf8'
    );

    const result = await syncBrandAssets({ root });

    const favicon = await readFile(join(root, 'apps/web/public/debrute.svg'), 'utf8');
    const desktopSvg = await readFile(join(root, 'apps/desktop/build/icon.svg'), 'utf8');
    expect(favicon).toContain('data-profile="favicon"');
    expect(desktopSvg).toContain('data-profile="application"');
    expect(favicon).toContain('id="mascot"');
    expect(desktopSvg).toContain('id="mascot"');
    expect(favicon).not.toBe(svg);
    expect(desktopSvg).not.toBe(svg);
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
      'apps/runtime/assets/tray-icon-macos-template.png',
      'apps/runtime/assets/tray-icon-windows.png',
      'apps/web/public/debrute.svg'
    ]);

    await expectPngDimensions(join(root, 'apps/desktop/build/logo.png'), 1024, 1024);
    await expectPngDimensions(join(root, 'apps/desktop/build/dock_icon.png'), 1024, 1024);
    await expectPngDimensions(join(root, 'apps/desktop/build/icon.png'), 1024, 1024);
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
      await expectPngDimensions(join(root, `apps/desktop/build/icons/${size}x${size}.png`), size, size);
      expect(await alphaAt(join(root, `apps/desktop/build/icons/${size}x${size}.png`), 0, 0)).toBe(0);
      expect(await alphaCoverage(join(root, `apps/desktop/build/icons/${size}x${size}.png`))).toBeGreaterThan(0.5);
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
    expect(await firstOpaqueXAtY(join(root, 'apps/desktop/build/dock_icon.png'), 102)).toBeGreaterThan(220);
    expect(await dockAlphaCoverage(join(root, 'apps/desktop/build/dock_icon.png'))).toBeGreaterThan(0.55);
    expect(await darkPixelCoverage(join(root, 'apps/desktop/build/dock_icon.png'))).toBeLessThan(0.35);
    expect(await brightPixelCoverage(join(root, 'apps/desktop/build/dock_icon.png'))).toBeGreaterThan(0.2);
    await expectPngDimensions(join(root, 'apps/runtime/assets/tray-icon-macos-template.png'), 36, 36);
    await expectPngDimensions(join(root, 'apps/runtime/assets/tray-icon-windows.png'), 66, 66);
    expect(await alphaAt(join(root, 'apps/runtime/assets/tray-icon-macos-template.png'), 0, 0)).toBe(0);
    expect(await alphaAt(join(root, 'apps/runtime/assets/tray-icon-windows.png'), 0, 0)).toBe(0);
    expect(await opaqueRgbValues(join(root, 'apps/runtime/assets/tray-icon-macos-template.png'))).toEqual([
      '255,255,255'
    ]);
    expect(await interiorTransparencyCoverage(join(root, 'apps/runtime/assets/tray-icon-macos-template.png'))).toBeGreaterThan(0.01);
    expect((await opaqueRgbValues(join(root, 'apps/runtime/assets/tray-icon-windows.png'))).length).toBeGreaterThan(1);
    const icns = await readFile(join(root, 'apps/desktop/build/icon.icns'));
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
    const ico = await readFile(join(root, 'apps/desktop/build/icon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(4);
  });

  it('keeps committed product icons byte-identical to canonical generation', async () => {
    const repositoryRoot = process.cwd();
    const root = await mkdtemp(join(tmpdir(), 'debrute-committed-brand-assets-'));
    await mkdir(join(root, 'assets/brand/materials'), { recursive: true });
    await writeFile(
      join(root, 'assets/brand/debrute-mascot.svg'),
      await readFile(join(repositoryRoot, 'assets/brand/debrute-mascot.svg'))
    );
    await writeFile(
      join(root, 'assets/brand/materials/cut-large.svg'),
      await readFile(join(repositoryRoot, 'assets/brand/materials/cut-large.svg'))
    );

    const result = await syncBrandAssets({ root });
    for (const target of result.targets) {
      const relativeTarget = target.slice(root.length + 1);
      expect(await readFile(target), relativeTarget).toEqual(
        await readFile(join(repositoryRoot, relativeTarget))
      );
    }
  });

  it('fails when the canonical mascot SVG is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-brand-assets-missing-'));

    await expect(syncBrandAssets({ root })).rejects.toThrow('Missing canonical brand mascot');
  });

  it('keeps generated desktop icon build resources available to Git', () => {
    for (const asset of [
      'apps/desktop/build/dock_icon.png',
      'apps/desktop/build/icon.png',
      'apps/desktop/build/icon.icns',
      'apps/desktop/build/icons/1024x1024.png'
    ]) {
      const result = spawnSync('git', ['check-ignore', '-q', asset], { cwd: process.cwd() });
      expect(result.status, asset).toBe(1);
    }
  });

  it('wires brand generation into Web and Electron consumers', () => {
    const root = process.cwd();
    const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const desktopPackage = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      build: { icon?: string; directories: { buildResources: string } };
    };
    const webPackage = JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const webHtml = readFileSync(join(root, 'apps/web/index.html'), 'utf8');

    expect(rootPackage.scripts['brand:sync']).toBe('node scripts/sync-brand-assets.mjs');
    expect([
      ['root build', rootPackage.scripts.build],
      ['Web build', webPackage.scripts.build],
      ['Desktop build', desktopPackage.scripts.build],
      ['Desktop development bundle', desktopPackage.scripts['build:electron:dev']]
    ].filter(([, command]) => command.includes('brand:sync')).map(([owner]) => owner)).toEqual([
      'Web build'
    ]);
    expect(webHtml).toContain('<link rel="icon" type="image/svg+xml" href="/debrute.svg" />');
    expect(desktopPackage.build.directories.buildResources).toBe('build');
    expect(desktopPackage.build).not.toHaveProperty('icon');
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
  return data[(y * info.width + x) * info.channels + 3]!;
}

async function alphaCoverage(path: string): Promise<number> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let opaque = 0;
  for (let offset = 3; offset < data.length; offset += info.channels) {
    if (data[offset]! > 16) opaque += 1;
  }
  return opaque / (info.width * info.height);
}

async function alphaEdgeMargins(path: string): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alpha = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3]!;
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
    if (data[(y * info.width + x) * info.channels + 3]! > 0) {
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
      if (data[(y * info.width + x) * info.channels + 3]! > 16) {
        pixels += 1;
      }
    }
  }
  return pixels / (info.width * info.height);
}

async function interiorTransparencyCoverage(path: string): Promise<number> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let transparent = 0;
  let sampled = 0;
  for (let y = Math.floor(info.height * 0.2); y < Math.ceil(info.height * 0.8); y += 1) {
    for (let x = Math.floor(info.width * 0.2); x < Math.ceil(info.width * 0.8); x += 1) {
      sampled += 1;
      if (data[(y * info.width + x) * info.channels + 3]! < 16) {
        transparent += 1;
      }
    }
  }
  return transparent / sampled;
}

async function darkPixelCoverage(path: string): Promise<number> {
  return luminanceCoverage(path, (luminance) => luminance < 45);
}

async function brightPixelCoverage(path: string): Promise<number> {
  return luminanceCoverage(path, (luminance) => luminance > 170);
}

type BrandColorBlock = 'ink' | 'clay' | 'cream';

async function colorBlockIntersectionOverUnion(
  referencePath: string,
  canonicalPath: string,
  block: BrandColorBlock,
  startYRatio = 0,
  sourceBounds?: { left: number; top: number; width: number; height: number }
): Promise<number> {
  const size = 512;
  const extract = sourceBounds
    ? {
        left: Math.floor(sourceBounds.left / 4),
        top: Math.floor(sourceBounds.top / 4),
        width: Math.ceil(sourceBounds.width / 4),
        height: Math.ceil(sourceBounds.height / 4)
      }
    : undefined;
  const render = (path: string) => {
    const pipeline = sharp(path).resize(size, size).removeAlpha();
    return (extract ? pipeline.extract(extract) : pipeline).raw().toBuffer();
  };
  const [reference, canonical] = await Promise.all([render(referencePath), render(canonicalPath)]);
  const isBlock = block === 'ink'
    ? (red: number, green: number, blue: number) => red < 130 && green < 130 && blue < 125
    : block === 'clay'
      ? (red: number, green: number, blue: number) => red > 120
      && red > green * 1.34
      && green > blue * 1.1
      : (red: number, green: number, blue: number) => red > 180 && green > 160 && blue > 140;
  let intersection = 0;
  let union = 0;
  const rowWidth = extract?.width ?? size;
  const imageHeight = extract?.height ?? size;
  const startOffset = Math.floor(imageHeight * startYRatio) * rowWidth * 3;
  for (let offset = startOffset; offset < reference.length; offset += 3) {
    const referenceMatches = isBlock(reference[offset]!, reference[offset + 1]!, reference[offset + 2]!);
    const canonicalMatches = isBlock(canonical[offset]!, canonical[offset + 1]!, canonical[offset + 2]!);
    if (referenceMatches && canonicalMatches) intersection += 1;
    if (referenceMatches || canonicalMatches) union += 1;
  }
  return intersection / union;
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
      if (data[offset + 3]! === 0) continue;
      const luminance = 0.2126 * data[offset]! + 0.7152 * data[offset + 1]! + 0.0722 * data[offset + 2]!;
      if (predicate(luminance)) {
        pixels += 1;
      }
    }
  }
  return pixels / (info.width * info.height);
}

async function opaqueRgbValues(path: string): Promise<string[]> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const values = new Set<string>();
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (data[offset + 3]! > 0) {
      values.add(`${data[offset]},${data[offset + 1]},${data[offset + 2]}`);
    }
  }
  return [...values].sort();
}
