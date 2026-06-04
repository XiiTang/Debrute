import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  assertProjectTreeVisibleMutationPath,
  joinProjectPath,
  normalizeProjectDirectoryPath,
  normalizeProjectPathBasename,
  parentProjectPath,
  resolveExistingProjectPath,
  resolveProjectPathForWrite,
  resolveProjectPath
} from './projectPaths.js';

export type ProjectPathKind = 'file' | 'directory';

export interface ProjectPathOperationResult {
  projectRelativePath: string;
  kind: ProjectPathKind;
}

export interface CreateProjectPathInput {
  parentProjectRelativePath: string;
  name: string;
}

export interface RenameProjectPathInput {
  projectRelativePath: string;
  name: string;
}

export interface CopyOrMoveProjectPathInput {
  sourceProjectRelativePath: string;
  targetDirectoryProjectRelativePath: string;
}

export interface DeleteProjectPathInput {
  projectRelativePath: string;
}

export async function createProjectFile(projectRoot: string, input: CreateProjectPathInput): Promise<ProjectPathOperationResult> {
  const name = normalizeProjectPathBasename(input.name);
  const parentPath = normalizeProjectDirectoryPath(input.parentProjectRelativePath);
  const projectRelativePath = joinProjectPath(parentPath, name);
  assertProjectTreeVisibleMutationPath(projectRelativePath);
  await assertProjectDirectory(projectRoot, parentPath);
  await assertProjectPathMissing(projectRoot, projectRelativePath);
  const absolutePath = await resolveProjectPathForWrite(projectRoot, projectRelativePath);
  await writeFile(absolutePath, '', 'utf8');
  return { projectRelativePath, kind: 'file' };
}

export async function createProjectDirectory(projectRoot: string, input: CreateProjectPathInput): Promise<ProjectPathOperationResult> {
  const name = normalizeProjectPathBasename(input.name);
  const parentPath = normalizeProjectDirectoryPath(input.parentProjectRelativePath);
  const projectRelativePath = joinProjectPath(parentPath, name);
  assertProjectTreeVisibleMutationPath(projectRelativePath);
  await assertProjectDirectory(projectRoot, parentPath);
  await assertProjectPathMissing(projectRoot, projectRelativePath);
  await mkdir(await resolveProjectPathForWrite(projectRoot, projectRelativePath));
  return { projectRelativePath, kind: 'directory' };
}

export async function renameProjectPath(projectRoot: string, input: RenameProjectPathInput): Promise<ProjectPathOperationResult> {
  const sourcePath = normalizeProjectDirectoryPath(input.projectRelativePath);
  const name = normalizeProjectPathBasename(input.name);
  assertProjectTreeVisibleMutationPath(sourcePath);
  const kind = await projectPathKind(projectRoot, sourcePath);
  const targetPath = joinProjectPath(parentProjectPath(sourcePath), name);
  assertProjectTreeVisibleMutationPath(targetPath);
  await assertProjectPathMissing(projectRoot, targetPath);
  await rename(resolveProjectPath(projectRoot, sourcePath), resolveProjectPath(projectRoot, targetPath));
  return { projectRelativePath: targetPath, kind };
}

export async function copyProjectPath(projectRoot: string, input: CopyOrMoveProjectPathInput): Promise<ProjectPathOperationResult> {
  const sourcePath = normalizeProjectDirectoryPath(input.sourceProjectRelativePath);
  const targetDirectoryPath = normalizeProjectDirectoryPath(input.targetDirectoryProjectRelativePath);
  assertProjectTreeVisibleMutationPath(sourcePath);
  assertProjectTreeVisibleMutationPath(joinProjectPath(targetDirectoryPath, basename(sourcePath)));
  const kind = await projectPathKind(projectRoot, sourcePath);
  await assertProjectDirectory(projectRoot, targetDirectoryPath);
  const targetPath = await uniquePasteTargetPath(projectRoot, targetDirectoryPath, basename(sourcePath));
  await cp(resolveProjectPath(projectRoot, sourcePath), resolveProjectPath(projectRoot, targetPath), {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  return { projectRelativePath: targetPath, kind };
}

export async function moveProjectPath(projectRoot: string, input: CopyOrMoveProjectPathInput): Promise<ProjectPathOperationResult> {
  const sourcePath = normalizeProjectDirectoryPath(input.sourceProjectRelativePath);
  const targetDirectoryPath = normalizeProjectDirectoryPath(input.targetDirectoryProjectRelativePath);
  assertProjectTreeVisibleMutationPath(sourcePath);
  assertProjectTreeVisibleMutationPath(joinProjectPath(targetDirectoryPath, basename(sourcePath)));
  const kind = await projectPathKind(projectRoot, sourcePath);
  await assertProjectDirectory(projectRoot, targetDirectoryPath);
  if (kind === 'directory' && (targetDirectoryPath === sourcePath || targetDirectoryPath.startsWith(`${sourcePath}/`))) {
    throw new Error('Cannot move a directory into itself or one of its descendants.');
  }
  if (targetDirectoryPath === parentProjectPath(sourcePath)) {
    return { projectRelativePath: sourcePath, kind };
  }
  const targetPath = await uniquePasteTargetPath(projectRoot, targetDirectoryPath, basename(sourcePath));
  await rename(resolveProjectPath(projectRoot, sourcePath), resolveProjectPath(projectRoot, targetPath));
  return { projectRelativePath: targetPath, kind };
}

export async function deleteProjectPathPermanently(projectRoot: string, input: DeleteProjectPathInput): Promise<ProjectPathOperationResult> {
  const projectRelativePath = normalizeProjectDirectoryPath(input.projectRelativePath);
  assertProjectTreeVisibleMutationPath(projectRelativePath);
  const kind = await projectPathKind(projectRoot, projectRelativePath);
  await rm(resolveProjectPath(projectRoot, projectRelativePath), { recursive: true, force: false });
  return { projectRelativePath, kind };
}

export async function uniquePasteTargetPath(projectRoot: string, targetDirectoryProjectRelativePath: string, sourceName: string): Promise<string> {
  const targetDirectory = normalizeProjectDirectoryPath(targetDirectoryProjectRelativePath);
  const entries = await readdir(await resolveExistingProjectPath(projectRoot, targetDirectory), { withFileTypes: true });
  return joinProjectPath(
    targetDirectory,
    nextCopyProjectPathName(new Set(entries.map((entry) => entry.name)), normalizeProjectPathBasename(sourceName))
  );
}

export function nextCopyProjectPathName(existingNames: Set<string>, sourceName: string): string {
  if (!existingNames.has(sourceName)) {
    return sourceName;
  }
  const extension = extname(sourceName);
  const stem = extension ? sourceName.slice(0, -extension.length) : sourceName;
  let index = 1;
  while (true) {
    const suffix = index === 1 ? ' copy' : ` copy ${index}`;
    const candidate = `${stem}${suffix}${extension}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

async function assertProjectPathMissing(projectRoot: string, projectRelativePath: string): Promise<void> {
  const absolutePath = await resolveProjectPathForWrite(projectRoot, projectRelativePath);
  try {
    await stat(absolutePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error(`Project path already exists: ${projectRelativePath}`);
}

async function assertProjectDirectory(projectRoot: string, projectRelativePath: string): Promise<void> {
  const pathStat = await stat(await resolveExistingProjectPath(projectRoot, projectRelativePath));
  if (!pathStat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${projectRelativePath}`);
  }
}

async function projectPathKind(projectRoot: string, projectRelativePath: string): Promise<ProjectPathKind> {
  const pathStat = await stat(await resolveExistingProjectPath(projectRoot, projectRelativePath));
  if (pathStat.isDirectory()) {
    return 'directory';
  }
  if (pathStat.isFile()) {
    return 'file';
  }
  throw new Error(`Project path is not a file or directory: ${projectRelativePath}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
