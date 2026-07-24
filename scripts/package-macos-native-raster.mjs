import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
const execute = promisify(execFile);
if (target.platform !== 'macos') {
  throw new Error(`Expected a macOS native raster target, received ${identity}.`);
}
const archiveBytes = await readFile(archive);
validateNativeRasterArchive(archiveBytes, identity);
const zip = new AdmZip(archiveBytes);
const library = requiredEntry(zip, target.libraryPath);
const versions = requiredEntry(zip, target.versionsPath);
const versionsValue = JSON.parse(versions.toString('utf8'));
if (versionsValue.vips !== LIBVIPS_VERSION) {
  throw new Error(`Native raster archive reports libvips ${versionsValue.vips ?? 'unknown'}.`);
}

const runtimeDirectory = join(destination, 'runtime');
const linkDirectory = join(destination, 'link');
await rm(destination, { recursive: true, force: true });
await mkdir(runtimeDirectory, { recursive: true });
await mkdir(linkDirectory, { recursive: true });
const runtimeLibrary = join(runtimeDirectory, 'libvips.42.dylib');
await writeFile(runtimeLibrary, library);
await execute('install_name_tool', ['-id', '@rpath/libvips.42.dylib', runtimeLibrary]);
await execute('codesign', ['--force', '--sign', '-', runtimeLibrary]);
await cp(
  join(workspaceRoot, 'assets/licenses/libvips-LGPL-2.1.txt'),
  join(runtimeDirectory, 'LICENSE')
);
await cp(
  join(workspaceRoot, 'assets/licenses/libvips-THIRD-PARTY-NOTICES.md'),
  join(runtimeDirectory, 'THIRD-PARTY-NOTICES.md')
);
await writeFile(join(runtimeDirectory, 'versions.json'), versions);
for (const name of ['libvips.dylib', 'libglib-2.0.dylib', 'libgobject-2.0.dylib']) {
  await cp(join(runtimeDirectory, 'libvips.42.dylib'), join(linkDirectory, name));
}

await writeFile(join(destination, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  payloadRevision: NATIVE_RASTER_PAYLOAD_LOCK.payloadRevision,
  libvipsVersion: LIBVIPS_VERSION,
  platform: target.platform,
  architecture: target.architecture,
  rasterFormats: NATIVE_RASTER_PAYLOAD_LOCK.rasterFormats,
  sourceArchiveSha256: target.sha256,
  linkDirectory: 'link',
  runtimeFiles: await inventory(runtimeDirectory, 'runtime'),
  linkFiles: await inventory(linkDirectory, 'link')
}, null, 2)}\n`);

function requiredEntry(zip, path) {
  const entry = zip.getEntry(path);
  if (!entry || entry.isDirectory) {
    throw new Error(`Native raster archive entry is missing: ${path}`);
  }
  return entry.getData();
}

async function inventory(directory, prefix) {
  const names = (await readdir(directory)).sort();
  return await Promise.all(names.map(async (name) => {
    const bytes = await readFile(join(directory, name));
    return {
      path: `${prefix}/${name}`,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    };
  }));
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
