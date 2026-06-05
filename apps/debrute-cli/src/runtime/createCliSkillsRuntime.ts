import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDebruteSkillsSyncService,
  type DebruteSkillsSyncService
} from '@debrute/capability-runtime';

const ENTRY_DIR = typeof import.meta.url === 'string'
  ? dirname(fileURLToPath(import.meta.url))
  : resolvePkgExecutableEntryDir(process.execPath);
const PKG_ENTRY_DIR = resolvePkgExecutableEntryDir(process.execPath);

export interface CliSkillsRuntime {
  skillsService: DebruteSkillsSyncService;
  bundledSkillsRoot?: string;
  debruteVersion: string;
}

export async function createCliSkillsRuntime(): Promise<CliSkillsRuntime> {
  const bundledSkillsRoot = await resolveCliBundledSkillsRoot();
  const debruteVersion = await resolveCliDebruteVersion();
  return {
    skillsService: createDebruteSkillsSyncService({
      debruteVersion,
      ...(bundledSkillsRoot ? { bundledSkillsRoot } : {})
    }),
    ...(bundledSkillsRoot ? { bundledSkillsRoot } : {}),
    debruteVersion
  };
}

export async function resolveCliBundledSkillsRoot(entryDir = ENTRY_DIR): Promise<string | undefined> {
  if (await isReleasePayloadRoot(entryDir)) {
    return resolve(entryDir, 'skills');
  }
  if (resolve(PKG_ENTRY_DIR) !== resolve(entryDir) && await isReleasePayloadRoot(PKG_ENTRY_DIR)) {
    return resolve(PKG_ENTRY_DIR, 'skills');
  }
  const sourceRoot = await resolveSourceCheckoutRoot(entryDir, { requireSkills: true });
  return sourceRoot ? resolve(sourceRoot, 'skills') : undefined;
}

export async function resolveCliDebruteVersion(entryDir = ENTRY_DIR): Promise<string> {
  if (await isReleasePayloadRoot(entryDir)) {
    const releaseVersion = await readPackageVersion(resolve(entryDir, 'package.json'));
    if (releaseVersion) {
      return releaseVersion;
    }
  }
  if (resolve(PKG_ENTRY_DIR) !== resolve(entryDir) && await isReleasePayloadRoot(PKG_ENTRY_DIR)) {
    const pkgVersion = await readPackageVersion(resolve(PKG_ENTRY_DIR, 'package.json'));
    if (pkgVersion) {
      return pkgVersion;
    }
  }
  const sourceRoot = await resolveSourceCheckoutRoot(entryDir, { requireSkills: false });
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

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function readPackageVersion(path: string): Promise<string | undefined> {
  try {
    const parsed = await readPackageJson(path);
    return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function resolveSourceCheckoutRoot(entryDir: string, options: { requireSkills: boolean }): Promise<string | undefined> {
  let current = resolve(entryDir);
  while (true) {
    if (await isDebruteSourceCheckoutRoot(current, options)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function isDebruteSourceCheckoutRoot(path: string, options: { requireSkills: boolean }): Promise<boolean> {
  try {
    const packageJson = await readPackageJson(resolve(path, 'package.json'));
    return isRecord(packageJson)
      && packageJson.name === 'debrute'
      && await fileExists(resolve(path, 'apps/debrute-cli/src/index.ts'))
      && (!options.requireSkills || await directoryExists(resolve(path, 'skills')));
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function isReleasePayloadRoot(path: string): Promise<boolean> {
  return Boolean(await readPackageVersion(resolve(path, 'package.json')))
    && await directoryExists(resolve(path, 'skills'))
    && (await fileExists(resolve(path, 'debrute')) || await fileExists(resolve(path, 'debrute.exe')));
}

async function readPackageJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
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
