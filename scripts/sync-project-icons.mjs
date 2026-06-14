import { mkdir, readFile, copyFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), '..');

const iconTargets = [
  'apps/web/public/debrute.svg',
  'apps/desktop/build/icon.svg'
];
const desktopBuildDir = 'apps/desktop/build';
const desktopPngTarget = `${desktopBuildDir}/icon.png`;
const desktopDockTarget = `${desktopBuildDir}/dock_icon.png`;
const desktopLogoTarget = `${desktopBuildDir}/logo.png`;
const desktopIcnsTarget = `${desktopBuildDir}/icon.icns`;
const desktopIcoTarget = `${desktopBuildDir}/icon.ico`;
const desktopTrayTarget = `${desktopBuildDir}/tray_icon.png`;
const desktopTrayTemplateTarget = `${desktopBuildDir}/tray_icon_template.png`;
const desktopTrayTemplate2xTarget = `${desktopBuildDir}/tray_icon_template@2x.png`;
const runtimeTrayStatuses = ['starting', 'running', 'degraded', 'stopped', 'error'];
const runtimeTrayStatusColors = {
  starting: { r: 74, g: 144, b: 226 },
  running: { r: 28, g: 184, b: 111 },
  degraded: { r: 245, g: 166, b: 35 },
  stopped: { r: 142, g: 142, b: 147 },
  error: { r: 225, g: 80, b: 72 }
};
const runtimeTrayStatusTargets = runtimeTrayStatuses.map((status) => `${desktopBuildDir}/tray_icon_${status}.png`);
const appIconSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const icoIconSizes = [16, 32, 48, 256];
const neutralIconRadiusRatio = 0.2;
const macIconRadiusRatio = 0.2;
const windowsIconRadiusRatio = 0.12;
const appIconInsetRatio = 0.08;
const macIconInsetRatio = 0.1;
const macIconForegroundRatio = 0.9;
const trayIconSize = 66;
const trayIconContentSize = 60;
const trayTemplateIconSize = 18;
const trayTemplateIconContentSize = 16;
const trayTemplateIcon2xSize = 36;
const trayTemplateIcon2xContentSize = 32;

export async function syncProjectIcons({ root = defaultRoot } = {}) {
  const source = resolve(root, 'assets/project-icon/debrute.svg');
  const svg = await readCanonicalSvg(source);
  const generatedTargets = [
    desktopLogoTarget,
    desktopPngTarget,
    desktopDockTarget,
    desktopIcnsTarget,
    desktopIcoTarget,
    desktopTrayTarget,
    desktopTrayTemplateTarget,
    desktopTrayTemplate2xTarget,
    ...runtimeTrayStatusTargets,
    ...appIconSizes.map((size) => `${desktopBuildDir}/icons/${size}x${size}.png`)
  ];

  await Promise.all(iconTargets.map(async (relativeTarget) => {
    const target = resolve(root, relativeTarget);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }));
  await removeStaleIconOutputs(root);
  await writePng(svg, resolve(root, desktopLogoTarget), 1024);
  await writeAppIconPng(svg, resolve(root, desktopPngTarget), 1024, neutralIconRadiusRatio);
  await writeMacAppIconPng(svg, resolve(root, desktopDockTarget), 1024);

  const macIconPngs = new Map();
  const windowsIconPngs = new Map();
  await Promise.all(appIconSizes.map(async (size) => {
    const neutralPng = await appIconPng(svg, size, neutralIconRadiusRatio);
    const target = resolve(root, `${desktopBuildDir}/icons/${size}x${size}.png`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, neutralPng);
    macIconPngs.set(size, await macAppIconPng(svg, size));
    if (icoIconSizes.includes(size)) {
      windowsIconPngs.set(size, await appIconPng(svg, size, windowsIconRadiusRatio));
    }
  }));
  await writeFile(resolve(root, desktopIcnsTarget), icnsBuffer(macIconPngs));
  await writeFile(resolve(root, desktopIcoTarget), icoBuffer(windowsIconPngs));
  await writeFile(resolve(root, desktopTrayTarget), await trayIconPng(svg));
  await writeFile(
    resolve(root, desktopTrayTemplateTarget),
    await trayTemplateIconPng(svg, trayTemplateIconSize, trayTemplateIconContentSize)
  );
  await writeFile(
    resolve(root, desktopTrayTemplate2xTarget),
    await trayTemplateIconPng(svg, trayTemplateIcon2xSize, trayTemplateIcon2xContentSize)
  );
  await Promise.all(runtimeTrayStatuses.map(async (status) => {
    await writeFile(
      resolve(root, `${desktopBuildDir}/tray_icon_${status}.png`),
      await trayStatusIconPng(svg, runtimeTrayStatusColors[status])
    );
  }));

  return {
    source,
    targets: [...iconTargets, ...generatedTargets].map((relativeTarget) => resolve(root, relativeTarget)),
    bytes: Buffer.byteLength(svg)
  };
}

async function removeStaleIconOutputs(root) {
  await Promise.all([
    rm(resolve(root, `${desktopBuildDir}/icons`), { recursive: true, force: true }),
    rm(resolve(root, `${desktopBuildDir}/tray_icon_dark.png`), { force: true }),
    rm(resolve(root, `${desktopBuildDir}/tray_icon_light.png`), { force: true })
  ]);
}

async function writePng(svg, target, size) {
  await mkdir(dirname(target), { recursive: true });
  await sharp(Buffer.from(svg))
    .resize(size, size, { fit: 'fill' })
    .png()
    .toFile(target);
}

async function writeAppIconPng(svg, target, size, radiusRatio) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await appIconPng(svg, size, radiusRatio));
}

async function appIconPng(svg, size, radiusRatio) {
  return maskedIconPng(svg, size, appIconInsetRatio, (contentSize) => (
    roundedRectangleMask(contentSize, radiusRatio)
  ));
}

async function writeMacAppIconPng(svg, target, size) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await macAppIconPng(svg, size));
}

async function macAppIconPng(svg, size) {
  const inset = Math.round(size * macIconInsetRatio);
  const contentSize = size - inset * 2;
  const background = sourceBackgroundColor(svg);
  const foregroundSize = Math.round(contentSize * macIconForegroundRatio);
  const foreground = await foregroundIconPng(svg, foregroundSize);
  const iconBody = await sharp({
    create: {
      width: contentSize,
      height: contentSize,
      channels: 4,
      background: { ...background, alpha: 1 }
    }
  })
    .composite([
      { input: foreground, gravity: 'center' },
      { input: await roundedRectangleMask(contentSize, macIconRadiusRatio), blend: 'dest-in' }
    ])
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{ input: iconBody, left: inset, top: inset }])
    .png()
    .toBuffer();
}

async function maskedIconPng(svg, size, insetRatio, maskForContentSize) {
  const inset = Math.round(size * insetRatio);
  const contentSize = size - inset * 2;
  const rendered = await sharp(Buffer.from(svg))
    .resize(contentSize, contentSize, { fit: 'fill' })
    .png()
    .toBuffer();
  const iconBody = await sharp(rendered)
    .ensureAlpha()
    .composite([{ input: await maskForContentSize(contentSize), blend: 'dest-in' }])
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{ input: iconBody, left: inset, top: inset }])
    .png()
    .toBuffer();
}

async function trayIconPng(svg) {
  const cutout = removeBackgroundLayer(svg);
  const trimmed = await sharp(Buffer.from(cutout))
    .resize(1024, 1024, { fit: 'fill' })
    .png()
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const content = await sharp(trimmed)
    .resize(trayIconContentSize, trayIconContentSize, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: trayIconSize,
      height: trayIconSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{ input: content, gravity: 'center' }])
    .png()
    .toBuffer();
}

async function trayStatusIconPng(svg, statusColor) {
  const base = await trayIconPng(svg);
  const badgeSize = 20;
  const badge = await sharp({
    create: {
      width: badgeSize,
      height: badgeSize,
      channels: 4,
      background: { ...statusColor, alpha: 1 }
    }
  })
    .composite([{ input: await roundedRectangleMask(badgeSize, 0.5), blend: 'dest-in' }])
    .png()
    .toBuffer();
  return sharp(base)
    .composite([{ input: badge, left: trayIconSize - badgeSize - 3, top: trayIconSize - badgeSize - 3 }])
    .png()
    .toBuffer();
}

async function trayTemplateIconPng(svg, size, contentSize) {
  const content = await foregroundIconPng(svg, contentSize);
  const { data, info } = await sharp(content)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const templatePixels = Buffer.alloc(info.width * info.height * 4);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const targetOffset = (y * info.width + x) * 4;
      templatePixels[targetOffset] = 255;
      templatePixels[targetOffset + 1] = 255;
      templatePixels[targetOffset + 2] = 255;
      templatePixels[targetOffset + 3] = data[offset + 3];
    }
  }
  const templateContent = await sharp(templatePixels, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4
    }
  }).png().toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{ input: templateContent, gravity: 'center' }])
    .png()
    .toBuffer();
}

async function foregroundIconPng(svg, size) {
  const cutout = removeBackgroundLayer(svg);
  const trimmed = await sharp(Buffer.from(cutout))
    .resize(1024, 1024, { fit: 'fill' })
    .png()
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  return sharp(trimmed)
    .resize(size, size, { fit: 'inside' })
    .png()
    .toBuffer();
}

async function roundedRectangleMask(size, radiusRatio) {
  const radius = Math.round(size * radiusRatio);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const pixelX = x + 0.5;
      const pixelY = y + 0.5;
      const nearestX = Math.max(radius, Math.min(size - radius, pixelX));
      const nearestY = Math.max(radius, Math.min(size - radius, pixelY));
      const distanceX = pixelX - nearestX;
      const distanceY = pixelY - nearestY;
      const inside = distanceX * distanceX + distanceY * distanceY <= radius * radius;
      const offset = (y * size + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = inside ? 255 : 0;
    }
  }
  return sharp(pixels, {
    raw: {
      width: size,
      height: size,
      channels: 4
    }
  }).png().toBuffer();
}

function removeBackgroundLayer(svg) {
  return svg.replace(/(<svg\b[^>]*>)(\s*)(?:<path\b[^>]*\/>|<rect\b[^>]*\/>)/, '$1$2');
}

function sourceBackgroundColor(svg) {
  const firstShape = svg.match(/<svg\b[^>]*>\s*(<path\b[^>]*\/>|<rect\b[^>]*\/>)/);
  const shape = firstShape?.[1] ?? '';
  const fill = shape.match(/\bfill=["'](#[0-9a-fA-F]{6})["']/)?.[1]
    ?? shape.match(/\bstyle=["'][^"']*\bfill:\s*(#[0-9a-fA-F]{6})\b/)?.[1];
  if (!fill) {
    throw new Error('Canonical project icon background layer must declare a hex fill color.');
  }
  return {
    r: Number.parseInt(fill.slice(1, 3), 16),
    g: Number.parseInt(fill.slice(3, 5), 16),
    b: Number.parseInt(fill.slice(5, 7), 16)
  };
}

function icnsBuffer(pngsBySize) {
  const entries = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024]
  ].map(([type, size]) => icnsEntry(type, requirePng(pngsBySize, size)));
  const totalLength = 8 + entries.reduce((sum, entry) => sum + entry.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(totalLength, 4);
  return Buffer.concat([header, ...entries], totalLength);
}

function icnsEntry(type, png) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 'ascii');
  header.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([header, png], png.length + 8);
}

function icoBuffer(pngsBySize) {
  const pngs = icoIconSizes.map((size) => ({ size, png: requirePng(pngsBySize, size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const directoryEntries = pngs.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...directoryEntries, ...pngs.map(({ png }) => png)]);
}

function requirePng(pngsBySize, size) {
  const png = pngsBySize.get(size);
  if (!png) {
    throw new Error(`Missing generated icon PNG: ${size}x${size}`);
  }
  return png;
}

async function readCanonicalSvg(source) {
  let content;
  try {
    content = await readFile(source, 'utf8');
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`Missing canonical project icon: ${source}`);
    }
    throw error;
  }

  if (!/<svg[\s>]/.test(content)) {
    throw new Error(`Canonical project icon is not an SVG file: ${source}`);
  }
  return content;
}

function isMissingPathError(error) {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await syncProjectIcons();
}
