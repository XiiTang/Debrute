import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  nativeRasterTargetLock,
  platformIdentity,
  validateNativeRasterArchive,
  validateNativeRasterPayload
} from './native-raster-payload.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function ensureNativeRasterPayload() {
  const identity = platformIdentity();
  const destination = join(workspaceRoot, '.scratch/native-raster-payloads', identity);
  try {
    return await validateNativeRasterPayload({ root: destination });
  } catch {
    // The prepared payload is a disposable cache; rebuild it from the locked archive.
  }

  const target = nativeRasterTargetLock(identity);
  const downloadDirectory = join(workspaceRoot, '.scratch/native-raster-downloads');
  const archive = join(downloadDirectory, `${identity}.${target.archiveFormat}`);
  await mkdir(downloadDirectory, { recursive: true });
  let archiveBytes = await readFile(archive).catch(() => undefined);
  try {
    if (!archiveBytes) throw new Error('Archive is not cached.');
    validateNativeRasterArchive(archiveBytes, identity);
  } catch {
    const response = await fetch(target.url);
    if (!response.ok) {
      throw new Error(`Native raster payload download failed: HTTP ${response.status}`);
    }
    archiveBytes = Buffer.from(await response.arrayBuffer());
    validateNativeRasterArchive(archiveBytes, identity);
    await writeFile(archive, archiveBytes);
  }

  const packager = target.platform === 'macos'
    ? 'scripts/package-macos-native-raster.mjs'
    : 'scripts/package-windows-native-raster.mjs';
  await run([
    packager,
    '--archive', archive,
    '--destination', destination,
    '--identity', identity
  ]);
  const payload = await validateNativeRasterPayload({ root: destination });
  console.log(`Native raster payload is ready: ${destination}`);
  return payload;
}

async function run(arguments_) {
  const child = spawn(process.execPath, arguments_, {
    cwd: workspaceRoot,
    stdio: 'inherit'
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(`Native raster payload packaging failed with code ${exitCode ?? 'unknown'}.`);
  }
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  await ensureNativeRasterPayload();
}
