import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NATIVE_RASTER_PAYLOAD_LOCK = JSON.parse(await readFile(
  join(workspaceRoot, 'assets/native-raster-payload-lock.json'),
  'utf8'
));
export const LIBVIPS_VERSION = NATIVE_RASTER_PAYLOAD_LOCK.libvipsVersion;

validateNativeRasterLock();

export function nativeRasterTargetLock(identity = platformIdentity()) {
  const target = NATIVE_RASTER_PAYLOAD_LOCK.targets[identity];
  if (!target) {
    throw new Error(`Native raster payload target is unsupported: ${identity}`);
  }
  return target;
}

export function validateNativeRasterLock() {
  const lock = NATIVE_RASTER_PAYLOAD_LOCK;
  const expectedTargets = ['macos-arm64', 'macos-x64', 'windows-x64'];
  if (
    lock.schemaVersion !== 1
    || lock.payloadRevision !== 2
    || lock.rsVipsVersion !== '0.7.0'
    || lock.libvipsVersion !== '8.18.4'
    || JSON.stringify(lock.rasterFormats) !== JSON.stringify(['jpeg', 'png', 'webp', 'avif', 'tiff'])
    || JSON.stringify(Object.keys(lock.targets ?? {}).sort()) !== JSON.stringify(expectedTargets)
  ) {
    throw new Error('Native raster payload lock identity is invalid.');
  }
  for (const identity of expectedTargets) {
    const target = lock.targets[identity];
    if (
      `${target.platform}-${target.architecture}` !== identity
      || !/^https:\/\//.test(target.url)
      || !/^[a-f0-9]{64}$/.test(target.sha256)
      || !['nupkg', 'zip'].includes(target.archiveFormat)
    ) {
      throw new Error(`Native raster payload lock target is invalid: ${identity}`);
    }
  }
  return lock;
}

export function validateNativeRasterArchive(bytes, identity = platformIdentity()) {
  const target = nativeRasterTargetLock(identity);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== target.sha256) {
    throw new Error(`Native raster archive checksum does not match its lock: ${identity}`);
  }
  return target;
}

export async function prepareNativeRasterPayload({ profile = 'debug' } = {}) {
  if (!['debug', 'release'].includes(profile)) {
    throw new Error(`Unsupported Cargo profile for native raster payload: ${profile}`);
  }
  const payload = await validateNativeRasterPayload();
  const targetDirectory = join(workspaceRoot, 'target', profile);
  const stagedDirectory = join(targetDirectory, 'native-raster');
  await rm(stagedDirectory, { recursive: true, force: true });
  await mkdir(stagedDirectory, { recursive: true });
  for (const file of payload.manifest.runtimeFiles) {
    await copyFile(join(payload.root, file.path), join(stagedDirectory, basename(file.path)));
  }

  if (process.platform === 'darwin') {
    const runtimeDirectory = join(targetDirectory, 'libvips');
    await rm(runtimeDirectory, { recursive: true, force: true });
    await cp(stagedDirectory, runtimeDirectory, { recursive: true, dereference: true });
  } else if (process.platform === 'win32') {
    for (const file of payload.manifest.runtimeFiles) {
      await copyFile(join(payload.root, file.path), join(targetDirectory, basename(file.path)));
    }
  }

  return {
    ...process.env,
    DEBRUTE_LIBVIPS_LIB_DIR: join(payload.root, payload.manifest.linkDirectory)
  };
}

export async function validateNativeRasterPayload({ root: configuredRoot } = {}) {
  const root = resolve(
    configuredRoot
      ?? join(workspaceRoot, '.scratch/native-raster-payloads', platformIdentity())
  );
  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const expectedPlatform = process.platform === 'darwin' ? 'macos' : 'windows';
  if (
    manifest.schemaVersion !== 1
    || manifest.payloadRevision !== NATIVE_RASTER_PAYLOAD_LOCK.payloadRevision
    || manifest.libvipsVersion !== LIBVIPS_VERSION
    || manifest.platform !== expectedPlatform
    || manifest.architecture !== process.arch
    || manifest.sourceArchiveSha256 !== nativeRasterTargetLock().sha256
    || JSON.stringify(manifest.rasterFormats) !== JSON.stringify(NATIVE_RASTER_PAYLOAD_LOCK.rasterFormats)
    || typeof manifest.linkDirectory !== 'string'
    || !Array.isArray(manifest.runtimeFiles)
    || !Array.isArray(manifest.linkFiles)
  ) {
    throw new Error(`Native raster payload identity is invalid: ${manifestPath}`);
  }
  const declaredPaths = new Set();
  for (const file of [...manifest.runtimeFiles, ...manifest.linkFiles]) {
    if (
      typeof file?.path !== 'string'
      || !/^[a-zA-Z0-9._/-]+$/.test(file.path)
      || file.path.startsWith('/')
      || file.path.includes('..')
      || declaredPaths.has(file.path)
      || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.sizeBytes)
      || file.sizeBytes <= 0
    ) {
      throw new Error(`Native raster payload file declaration is invalid: ${manifestPath}`);
    }
    declaredPaths.add(file.path);
    const path = join(root, file.path);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== file.sizeBytes) {
      throw new Error(`Native raster payload file size does not match its lock: ${path}`);
    }
    const bytes = await readFile(path);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== file.sha256) {
      throw new Error(`Native raster payload checksum does not match its lock: ${path}`);
    }
  }
  await assertClosedInventory(root, 'runtime', manifest.runtimeFiles, manifestPath);
  await assertClosedInventory(root, manifest.linkDirectory, manifest.linkFiles, manifestPath);
  return { root, manifest };
}

export function platformIdentity() {
  if (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) {
    return `macos-${process.arch}`;
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'windows-x64';
  }
  throw new Error(`Native raster payload is unsupported on ${process.platform}-${process.arch}`);
}

async function copyFile(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { dereference: true });
}

async function assertClosedInventory(root, directory, files, manifestPath) {
  const actual = (await readdir(join(root, directory))).sort();
  const declared = files.map((file) => basename(file.path)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(declared)) {
    throw new Error(`Native raster payload ${directory} inventory is not closed: ${manifestPath}`);
  }
}
