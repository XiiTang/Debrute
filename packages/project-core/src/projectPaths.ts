import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  normalizeProjectDirectoryPath,
  normalizeProjectPath,
  normalizeProjectRelativePath
} from './projectPathNormalization.js';

export {
  normalizeProjectDirectoryPath,
  normalizeProjectRelativePath
} from './projectPathNormalization.js';

export function userHomeDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error('User home directory is not available.');
  }
  return home;
}

export function debruteHomeDir(): string {
  return join(userHomeDir(), '.debrute');
}

export function normalizeProjectPathBasename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Project path name must be non-empty.');
  }
  if (trimmed === '.' || trimmed === '..' || trimmed !== basename(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('Project path name must be a basename.');
  }
  return trimmed;
}

export function parentProjectPath(projectRelativePath: string): string {
  const parts = normalizeProjectDirectoryPath(projectRelativePath).split('/').filter(Boolean);
  return parts.length <= 1 ? '' : parts.slice(0, -1).join('/');
}

export function joinProjectPath(parentPath: string, name: string): string {
  const safeName = normalizeProjectPathBasename(name);
  const normalizedParent = normalizeProjectDirectoryPath(parentPath);
  return normalizedParent ? `${normalizedParent}/${safeName}` : safeName;
}

export function resolveProjectPath(projectRoot: string, projectRelativePath: string): string {
  const normalizedPath = normalizeProjectPath(projectRelativePath, { allowEmpty: true });
  const root = resolve(projectRoot);
  const absolutePath = resolve(root, normalizedPath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    throw new Error(`Project path escapes project root: ${projectRelativePath}`);
  }
  return absolutePath;
}

export async function resolveExistingProjectPath(projectRoot: string, projectRelativePath: string): Promise<string> {
  const absolutePath = resolveProjectPath(projectRoot, projectRelativePath);
  const [rootRealPath, targetRealPath] = await Promise.all([
    realpath(projectRoot),
    realpath(absolutePath)
  ]);
  assertRealPathInsideProjectRoot(rootRealPath, targetRealPath, projectRelativePath);
  return targetRealPath;
}

export async function resolveProjectPathForWrite(projectRoot: string, projectRelativePath: string): Promise<string> {
  const absolutePath = resolveProjectPath(projectRoot, projectRelativePath);
  const rootRealPath = await realpath(projectRoot);
  const existingTarget = await realpathOrUndefined(absolutePath);
  if (existingTarget) {
    assertRealPathInsideProjectRoot(rootRealPath, existingTarget, projectRelativePath);
    return absolutePath;
  }

  const existingParent = await nearestExistingParentRealPath(projectRoot, dirname(absolutePath));
  assertRealPathInsideProjectRoot(rootRealPath, existingParent, projectRelativePath);
  return absolutePath;
}

export async function resolveNoSymlinkExistingProjectPath(projectRoot: string, projectRelativePath: string): Promise<string> {
  const absolutePath = resolveProjectPath(projectRoot, projectRelativePath);
  const [rootRealPath, targetLinkStat] = await Promise.all([
    realpath(projectRoot),
    lstat(absolutePath)
  ]);
  if (targetLinkStat.isSymbolicLink()) {
    throw new Error(`Project path must not be a symbolic link: ${projectRelativePath}`);
  }
  const targetRealPath = await realpath(absolutePath);
  assertRealPathInsideProjectRoot(rootRealPath, targetRealPath, projectRelativePath);
  return absolutePath;
}

export async function resolveNoSymlinkProjectPathForWrite(projectRoot: string, projectRelativePath: string): Promise<string> {
  const absolutePath = resolveProjectPath(projectRoot, projectRelativePath);
  const rootRealPath = await realpath(projectRoot);
  try {
    const targetLinkStat = await lstat(absolutePath);
    if (targetLinkStat.isSymbolicLink()) {
      throw new Error(`Project path must not be a symbolic link: ${projectRelativePath}`);
    }
    const targetRealPath = await realpath(absolutePath);
    assertRealPathInsideProjectRoot(rootRealPath, targetRealPath, projectRelativePath);
    return absolutePath;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const existingParent = await nearestExistingParentRealPath(projectRoot, dirname(absolutePath));
  assertRealPathInsideProjectRoot(rootRealPath, existingParent, projectRelativePath);
  return absolutePath;
}

export function assertProjectTreeVisibleMutationPath(projectRelativePath: string): void {
  const normalizedPath = normalizeProjectRelativePath(projectRelativePath);
  if (isProjectGitMetadataPath(normalizedPath) || isIgnoredProjectFilePath(normalizedPath)) {
    throw new Error(`Project path is not visible in the Project Tree: ${projectRelativePath}`);
  }
  if (isProtectedProjectDocumentMutationPath(normalizedPath)) {
    throw new Error(`Project path is protected by the Project Document System: ${projectRelativePath}`);
  }
}

export function isProjectGitMetadataPath(projectRelativePath: string): boolean {
  return isProjectPathSameOrChild(projectReservedNamespacePolicyPath(projectRelativePath), '.git');
}

export function isIgnoredProjectFilePath(projectRelativePath: string): boolean {
  const policyPath = projectReservedNamespacePolicyPath(projectRelativePath);
  return isProjectPathSameOrChild(policyPath, '.debrute/cache/canvas-image-previews')
    || isProjectPathSameOrChild(policyPath, '.debrute/cache/canvas-text-previews')
    || isProjectPathSameOrChild(policyPath, '.debrute/cache/canvas-video-previews')
    || isProjectPathSameOrChild(policyPath, '.debrute/reviews/rendered-feedback')
    || (isProjectPathSameOrChild(policyPath, '.debrute') && policyPath.endsWith('.lock'));
}

export function isProtectedProjectDocumentMutationPath(projectRelativePath: string): boolean {
  return isProjectPathSameOrChild(projectReservedNamespacePolicyPath(projectRelativePath), '.debrute');
}

function projectReservedNamespacePolicyPath(projectRelativePath: string): string {
  const firstSeparatorIndex = projectRelativePath.indexOf('/');
  const firstSegment = firstSeparatorIndex === -1
    ? projectRelativePath
    : projectRelativePath.slice(0, firstSeparatorIndex);
  const firstSegmentKey = firstSegment.toLowerCase();
  const policyFirstSegment = firstSegmentKey === '.git' || firstSegmentKey === '.debrute'
    ? firstSegmentKey
    : firstSegment;
  return firstSeparatorIndex === -1
    ? policyFirstSegment
    : `${policyFirstSegment}${projectRelativePath.slice(firstSeparatorIndex)}`;
}

function isProjectPathSameOrChild(projectRelativePath: string, parentProjectRelativePath: string): boolean {
  return projectRelativePath === parentProjectRelativePath
    || projectRelativePath.startsWith(`${parentProjectRelativePath}/`);
}

async function nearestExistingParentRealPath(projectRoot: string, absoluteParentPath: string): Promise<string> {
  const root = resolve(projectRoot);
  let current = resolve(absoluteParentPath);
  while (current !== root && current.startsWith(`${root}${sep}`)) {
    const realParent = await realpathOrUndefined(current);
    if (realParent) {
      return realParent;
    }
    current = dirname(current);
  }
  return realpath(root);
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function assertRealPathInsideProjectRoot(rootRealPath: string, targetRealPath: string, projectRelativePath: string): void {
  if (targetRealPath !== rootRealPath && !targetRealPath.startsWith(`${rootRealPath}${sep}`)) {
    throw new Error(`Project path escapes project root through a symlink: ${projectRelativePath}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
