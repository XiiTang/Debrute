import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const payloadFileNames = [
  'BUILD-CONFIG.txt',
  'LICENSE',
  'SOURCE.md',
  'THIRD-PARTY-NOTICES.md',
  'versions.json'
];

export const CANVAS_VIDEO_TOOLS_LOCK = JSON.parse(await readFile(
  join(workspaceRoot, 'assets/canvas-video-tools-lock.json'),
  'utf8'
));
export const FFMPEG_VERSION = CANVAS_VIDEO_TOOLS_LOCK.ffmpegVersion;
export const FFMPEG_SOURCE_ARCHIVE_NAME = `ffmpeg-${FFMPEG_VERSION}.tar.xz`;

validateCanvasVideoToolsLock();

export function canvasVideoToolsIdentity() {
  if (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) {
    return `macos-${process.arch}`;
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'windows-x64';
  }
  throw new Error(`Canvas video tools are unsupported on ${process.platform}-${process.arch}`);
}

export function canvasVideoToolsTarget(identity = canvasVideoToolsIdentity()) {
  const target = CANVAS_VIDEO_TOOLS_LOCK.targets[identity];
  if (!target) throw new Error(`Canvas video tools target is unsupported: ${identity}`);
  return target;
}

export function canvasVideoToolExecutableNames(identity = canvasVideoToolsIdentity()) {
  return canvasVideoToolsTarget(identity).platform === 'windows'
    ? ['ffmpeg.exe', 'ffprobe.exe']
    : ['ffmpeg', 'ffprobe'];
}

export function canRunCanvasVideoTools(identity = canvasVideoToolsIdentity()) {
  try {
    return identity === canvasVideoToolsIdentity();
  } catch {
    return false;
  }
}

export function validateCanvasVideoToolsLock() {
  const lock = CANVAS_VIDEO_TOOLS_LOCK;
  const expectedTargets = ['macos-arm64', 'macos-x64', 'windows-x64'];
  if (
    lock.schemaVersion !== 1
    || lock.payloadRevision !== 2
    || lock.ffmpegVersion !== '8.1.2'
    || lock.source?.url !== `https://ffmpeg.org/releases/ffmpeg-${lock.ffmpegVersion}.tar.xz`
    || lock.source?.signatureUrl !== `${lock.source.url}.asc`
    || lock.source?.signingKeyUrl !== 'https://ffmpeg.org/ffmpeg-devel.asc'
    || lock.source?.signingKeyFingerprint !== 'FCF986EA15E6E293A5644F10B4322F04D67658D8'
    || !/^[a-f0-9]{64}$/.test(lock.source?.sha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(lock.source?.signatureSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(lock.source?.signingKeySha256 ?? '')
    || JSON.stringify(Object.keys(lock.targets ?? {}).sort()) !== JSON.stringify(expectedTargets)
  ) {
    throw new Error('Canvas video tools lock identity is invalid.');
  }
  const configureArguments = lock.configureArguments;
  if (
    !Array.isArray(configureArguments)
    || configureArguments.length === 0
    || configureArguments.some((argument) => typeof argument !== 'string' || !argument.startsWith('--'))
    || configureArguments.includes('--enable-gpl')
    || configureArguments.includes('--enable-nonfree')
    || !configureArguments.includes('--disable-autodetect')
    || !configureArguments.includes('--disable-network')
    || !configureArguments.includes('--enable-ffmpeg')
    || !configureArguments.includes('--enable-ffprobe')
    || !configureArguments.includes('--disable-devices')
    || !configureArguments.includes('--disable-encoders')
    || !configureArguments.includes('--enable-encoder=mjpeg')
    || !configureArguments.includes('--disable-muxers')
    || !configureArguments.includes('--enable-muxer=image2')
    || !configureArguments.includes('--disable-filters')
    || !configureArguments.includes('--enable-filter=scale')
    || !configureArguments.includes('--disable-protocols')
    || !configureArguments.includes('--enable-protocol=file')
  ) {
    throw new Error('Canvas video tools configure contract is invalid.');
  }
  for (const identity of expectedTargets) {
    const target = lock.targets[identity];
    if (`${target.platform}-${target.architecture}` !== identity) {
      throw new Error(`Canvas video tools target is invalid: ${identity}`);
    }
  }
  return lock;
}

export function validateCanvasVideoToolsSource(bytes) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== CANVAS_VIDEO_TOOLS_LOCK.source.sha256) {
    throw new Error('FFmpeg source checksum does not match the Canvas video tools lock.');
  }
}

export async function validateCanvasVideoToolsPayload({
  root: configuredRoot,
  identity = canvasVideoToolsIdentity(),
  runExecutables = true
} = {}) {
  const root = resolve(configuredRoot ?? join(
    workspaceRoot,
    '.scratch/canvas-video-tools-payloads',
    identity
  ));
  const target = canvasVideoToolsTarget(identity);
  const manifestPath = join(root, 'versions.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const expectedExecutables = canvasVideoToolExecutableNames(identity);
  if (
    !hasExactKeys(manifest, [
      'architecture',
      'configureArguments',
      'ffmpegVersion',
      'files',
      'payloadRevision',
      'platform',
      'schemaVersion',
      'sourceSha256'
    ])
    || manifest.schemaVersion !== 1
    || manifest.payloadRevision !== CANVAS_VIDEO_TOOLS_LOCK.payloadRevision
    || manifest.ffmpegVersion !== FFMPEG_VERSION
    || manifest.platform !== target.platform
    || manifest.architecture !== target.architecture
    || manifest.sourceSha256 !== CANVAS_VIDEO_TOOLS_LOCK.source.sha256
    || JSON.stringify(manifest.configureArguments) !== JSON.stringify(CANVAS_VIDEO_TOOLS_LOCK.configureArguments)
    || !Array.isArray(manifest.files)
  ) {
    throw new Error(`Canvas video tools payload identity is invalid: ${manifestPath}`);
  }
  if (manifest.files.some((file) => (
    !hasExactKeys(file, ['path', 'sha256', 'sizeBytes'])
    || typeof file.path !== 'string'
    || basename(file.path) !== file.path
    || !/^[A-Za-z0-9._+-]+$/.test(file.path)
    || !Number.isSafeInteger(file.sizeBytes)
    || file.sizeBytes <= 0
    || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')
  ))) {
    throw new Error(`Canvas video tools payload declaration is invalid: ${manifestPath}`);
  }
  const expectedFiles = await requireClosedPayloadInventory(root, identity);
  const declaredFiles = manifest.files.map((file) => file.path).sort();
  if (JSON.stringify(declaredFiles) !== JSON.stringify(expectedFiles.filter((path) => path !== 'versions.json'))) {
    throw new Error(`Canvas video tools payload inventory is invalid: ${manifestPath}`);
  }
  for (const file of manifest.files) {
    const path = join(root, file.path);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== file.sizeBytes) {
      throw new Error(`Canvas video tools payload file size is invalid: ${path}`);
    }
    const actual = createHash('sha256').update(await readFile(path)).digest('hex');
    if (actual !== file.sha256) {
      throw new Error(`Canvas video tools payload checksum is invalid: ${path}`);
    }
  }
  if (runExecutables) {
    for (const executable of expectedExecutables) {
      const path = join(root, executable);
      const output = await execFileAsync(path, ['-version'], { timeout: 10_000 });
      const version = `${output.stdout}\n${output.stderr}`;
      const program = executable.startsWith('ffprobe') ? 'ffprobe' : 'ffmpeg';
      if (
        !version.includes(`${program} version ${FFMPEG_VERSION}`)
        || version.includes('--enable-gpl')
        || version.includes('--enable-nonfree')
      ) {
        throw new Error(`Canvas video tool version or license configuration is invalid: ${path}`);
      }
    }
  }
  return { root, manifest };
}

function hasExactKeys(value, expected) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

export async function stageCanvasVideoToolsPayload({
  profile = 'debug',
  root,
  identity = canvasVideoToolsIdentity()
} = {}) {
  if (!['debug', 'release'].includes(profile)) {
    throw new Error(`Unsupported Canvas video tools profile: ${profile}`);
  }
  const payload = await validateCanvasVideoToolsPayload({
    root,
    identity,
    runExecutables: canRunCanvasVideoTools(identity)
  });
  const destination = join(workspaceRoot, 'target', profile, 'canvas-video-tools');
  if (resolve(payload.root) === resolve(destination)) {
    if (process.platform !== 'win32') {
      for (const executable of canvasVideoToolExecutableNames(identity)) {
        await chmod(join(destination, executable), 0o755);
      }
    }
    return destination;
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(payload.root, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`Canvas video tools payload must be flat: ${payload.root}`);
    const target = join(destination, entry.name);
    await cp(join(payload.root, entry.name), target, { dereference: true });
    if (canvasVideoToolExecutableNames(identity).includes(entry.name) && process.platform !== 'win32') {
      await chmod(target, 0o755);
    }
  }
  return destination;
}

export async function refreshCanvasVideoToolsPayloadManifest({
  root: configuredRoot,
  identity = canvasVideoToolsIdentity(),
  runExecutables = canRunCanvasVideoTools(identity)
} = {}) {
  const root = resolve(configuredRoot ?? join(
    workspaceRoot,
    '.scratch/canvas-video-tools-payloads',
    identity
  ));
  const target = canvasVideoToolsTarget(identity);
  const expectedFiles = await requireClosedPayloadInventory(root, identity);
  const files = await Promise.all(expectedFiles
    .filter((name) => name !== 'versions.json')
    .map((name) => manifestFile(join(root, name))));
  await writeFile(join(root, 'versions.json'), `${JSON.stringify({
    schemaVersion: 1,
    payloadRevision: CANVAS_VIDEO_TOOLS_LOCK.payloadRevision,
    ffmpegVersion: FFMPEG_VERSION,
    platform: target.platform,
    architecture: target.architecture,
    sourceSha256: CANVAS_VIDEO_TOOLS_LOCK.source.sha256,
    configureArguments: CANVAS_VIDEO_TOOLS_LOCK.configureArguments,
    files: files.sort((left, right) => left.path.localeCompare(right.path))
  }, null, 2)}\n`);
  return await validateCanvasVideoToolsPayload({
    root,
    identity,
    runExecutables
  });
}

export async function manifestFile(path) {
  const bytes = await readFile(path);
  return {
    path: basename(path),
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

async function requireClosedPayloadInventory(root, identity) {
  const expectedFiles = [
    ...payloadFileNames,
    ...canvasVideoToolExecutableNames(identity)
  ].sort();
  const actualFiles = (await readdir(root, { withFileTypes: true })).map((entry) => {
    if (!entry.isFile()) throw new Error(`Canvas video tools payload must be flat: ${root}`);
    return entry.name;
  }).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Canvas video tools payload contains undeclared files: ${root}`);
  }
  return expectedFiles;
}
