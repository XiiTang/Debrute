import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

import {
  LIBVIPS_VERSION,
  NATIVE_RASTER_PAYLOAD_LOCK,
  nativeRasterTargetLock,
  validateNativeRasterArchive
} from './native-raster-payload.mjs';

const archive = resolve(requiredArgument('--archive'));
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(requiredArgument('--destination'));
const identity = requiredArgument('--identity');
const target = nativeRasterTargetLock(identity);
if (target.platform !== 'windows') {
  throw new Error(`Expected a Windows native raster target, received ${identity}.`);
}
const archiveBytes = await readFile(archive);
validateNativeRasterArchive(archiveBytes, identity);
const zip = new AdmZip(archiveBytes);
const runtimePrefix = `${target.runtimeDirectory}/`;
const runtimeEntries = zip.getEntries().filter((entry) => (
  !entry.isDirectory
  && entry.entryName.startsWith(runtimePrefix)
  && /^[^/]+\.dll$/i.test(entry.entryName.slice(runtimePrefix.length))
));
if (!runtimeEntries.some((entry) => basename(entry.entryName).toLowerCase() === 'libvips-42.dll')) {
  throw new Error('Windows native raster archive has no Runtime library.');
}
const importLibrary = requiredEntry(zip, target.importLibraryPath);
const license = requiredEntry(zip, target.licensePath);
const versions = requiredEntry(zip, target.versionsPath);
const versionsValue = JSON.parse(versions.toString('utf8'));
if (versionsValue.vips !== LIBVIPS_VERSION) {
  throw new Error(`Native raster archive reports libvips ${versionsValue.vips ?? 'unknown'}.`);
}

await rm(destination, { recursive: true, force: true });
const runtimeDirectory = join(destination, 'runtime');
const linkDirectory = join(destination, 'link');
await mkdir(runtimeDirectory, { recursive: true });
await mkdir(linkDirectory, { recursive: true });
for (const entry of runtimeEntries) {
  await writeFile(join(runtimeDirectory, basename(entry.entryName)), entry.getData());
}
await writeFile(join(runtimeDirectory, 'LICENSE'), license);
await writeFile(
  join(runtimeDirectory, 'THIRD-PARTY-NOTICES.md'),
  await readFile(join(workspaceRoot, 'assets/licenses/libvips-THIRD-PARTY-NOTICES.md'))
);
await writeFile(join(runtimeDirectory, 'versions.json'), versions);
await writeFile(join(linkDirectory, 'libvips.lib'), importLibrary);

const runtimeFiles = await Promise.all((await readdir(runtimeDirectory))
  .sort().map(async (name) => lockedFile(
    `runtime/${name}`,
    await readFile(join(runtimeDirectory, name))
  )));
await writeFile(join(destination, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  payloadRevision: NATIVE_RASTER_PAYLOAD_LOCK.payloadRevision,
  libvipsVersion: LIBVIPS_VERSION,
  platform: target.platform,
  architecture: target.architecture,
  rasterFormats: NATIVE_RASTER_PAYLOAD_LOCK.rasterFormats,
  sourceArchiveSha256: target.sha256,
  linkDirectory: 'link',
  runtimeFiles,
  linkFiles: [lockedFile('link/libvips.lib', importLibrary)]
}, null, 2)}\n`);

function requiredEntry(zip, path) {
  const entry = zip.getEntry(path);
  if (!entry || entry.isDirectory) {
    throw new Error(`Native raster archive entry is missing: ${path}`);
  }
  return entry.getData();
}

function lockedFile(path, bytes) {
  return {
    path,
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
