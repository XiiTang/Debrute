import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { validateProductSeed } from './assemble-product-seed.mjs';

const execFileAsync = promisify(execFile);

export async function findLocalMacosApplication(directory) {
  const root = resolve(directory);
  const matches = [];
  await collectApplications(root, matches);
  if (matches.length !== 1) {
    throw new Error(`Expected one local Debrute.app, found ${matches.length}: ${root}`);
  }
  return matches[0];
}

export async function replaceInstalledApplication({
  sourceApplication,
  applicationsDirectory,
  verifyApplication
}) {
  const source = resolve(sourceApplication);
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error(`Local application is not a real directory: ${source}`);
  }
  const destination = join(resolve(applicationsDirectory), 'Debrute.app');
  await replaceDirectoryAtomically(source, destination, verifyApplication);
  return destination;
}

export async function verifyLocalMacosApplication(application, expectedVersion) {
  const path = resolve(application);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Local application is not a real directory: ${path}`);
  }
  await execFileAsync('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    path
  ]);
  const signature = await execFileAsync('/usr/bin/codesign', ['-dvv', path]);
  if (!signature.stderr.includes('Signature=adhoc') || signature.stderr.includes('Authority=')) {
    throw new Error(`Local application is not ad-hoc signed: ${path}`);
  }
  const infoPlist = join(path, 'Contents/Info.plist');
  const bundleId = await plistValue(infoPlist, 'CFBundleIdentifier');
  const version = await plistValue(infoPlist, 'CFBundleShortVersionString');
  if (bundleId !== 'io.github.xiitang.debrute') {
    throw new Error(`Local application bundle id is invalid: ${bundleId}`);
  }
  if (version !== expectedVersion) {
    throw new Error(`Local application version ${version} does not match ${expectedVersion}.`);
  }
  const manifest = await validateProductSeed(join(path, 'Contents/Resources/product-seed'));
  if (manifest.productVersion !== expectedVersion) {
    throw new Error('Local application Product seed version does not match the application.');
  }
  return { bundleId, version, manifest };
}

async function replaceDirectoryAtomically(source, destination, verify) {
  const target = resolve(destination);
  const parent = dirname(target);
  const name = basename(target);
  const nonce = randomUUID();
  const staging = join(parent, `.${name}.install-${nonce}`);
  const backup = join(parent, `.${name}.previous-${nonce}`);
  await mkdir(parent, { recursive: true });
  const existing = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error(`Replacement target is not a real directory: ${target}`);
  }
  await cp(resolve(source), staging, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true
  });
  try {
    await verify(staging);
    if (!existing) {
      await rename(staging, target);
      return;
    }
    await rename(target, backup);
    try {
      await rename(staging, target);
    } catch (error) {
      await rename(backup, target);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function collectApplications(directory, matches) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name.toLowerCase() === 'debrute.app') {
      matches.push(path);
    } else if (entry.isDirectory()) {
      await collectApplications(path, matches);
    }
  }
}

async function plistValue(infoPlist, key) {
  const result = await execFileAsync('/usr/bin/plutil', [
    '-extract',
    key,
    'raw',
    infoPlist
  ]);
  return result.stdout.trim();
}
