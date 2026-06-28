import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY_DIR = typeof import.meta.url === 'string'
  ? dirname(fileURLToPath(import.meta.url))
  : resolvePkgExecutableEntryDir(process.execPath);
const PKG_ENTRY_DIR = resolvePkgExecutableEntryDir(process.execPath);

export async function resolveCliDebruteVersion(entryDir = ENTRY_DIR): Promise<string> {
  const entryVersion = await readPackageVersion(resolve(entryDir, 'package.json'));
  if (entryVersion && await isManagedCliPayloadRoot(entryDir)) {
    return entryVersion;
  }
  if (resolve(PKG_ENTRY_DIR) !== resolve(entryDir)) {
    const pkgVersion = await readPackageVersion(resolve(PKG_ENTRY_DIR, 'package.json'));
    if (pkgVersion && await isManagedCliPayloadRoot(PKG_ENTRY_DIR)) {
      return pkgVersion;
    }
  }
  const sourceRoot = await resolveSourceCheckoutRoot(entryDir);
  if (sourceRoot) {
    const sourceVersion = await readPackageVersion(resolve(sourceRoot, 'package.json'));
    if (sourceVersion) {
      return sourceVersion;
    }
  }
  throw new Error('Debrute CLI package metadata is unavailable.');
}

export function resolvePkgExecutableEntryDir(execPath: string): string {
  const windowsSeparator = execPath.lastIndexOf('\\');
  if (windowsSeparator >= 0) {
    return execPath.slice(0, windowsSeparator);
  }
  return dirname(execPath);
}

async function readPackageVersion(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function resolveSourceCheckoutRoot(entryDir: string): Promise<string | undefined> {
  let current = resolve(entryDir);
  while (true) {
    if (await isDebruteSourceCheckoutRoot(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function isDebruteSourceCheckoutRoot(path: string): Promise<boolean> {
  try {
    const packageJson = JSON.parse(await readFile(resolve(path, 'package.json'), 'utf8')) as unknown;
    return isRecord(packageJson)
      && packageJson.name === 'debrute'
      && await fileExists(resolve(path, 'apps/debrute-cli/src/index.ts'));
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function isManagedCliPayloadRoot(path: string): Promise<boolean> {
  return await fileExists(resolve(path, 'debrute')) || await fileExists(resolve(path, 'debrute.exe'));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
