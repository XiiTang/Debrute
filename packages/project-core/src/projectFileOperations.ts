import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join as joinFileSystemPath, resolve as resolveFileSystemPath, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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

interface CopySingleProjectPathInput {
  sourceProjectRelativePath: string;
  targetDirectoryProjectRelativePath: string;
}

export interface ProjectPathBatchEntry {
  projectRelativePath: string;
  kind: ProjectPathKind;
}

export interface CopyProjectPathsInput {
  entries: ProjectPathBatchEntry[];
  targetDirectoryProjectRelativePath: string;
}

export interface MoveProjectPathsInput {
  entries: ProjectPathBatchEntry[];
  targetDirectoryProjectRelativePath: string;
  overwrite?: boolean;
}

export interface DeleteProjectPathsInput {
  entries: ProjectPathBatchEntry[];
}

export interface ImportExternalLocalProjectPathsInput {
  sources: string[];
  targetDirectoryProjectRelativePath: string;
  overwrite?: boolean;
}

export type ProjectUploadImportEntry =
  | {
      kind: 'directory';
      projectRelativePath: string;
    }
  | {
      kind: 'file';
      projectRelativePath: string;
      content: Uint8Array | AsyncIterable<Uint8Array>;
    };

export interface ImportExternalUploadProjectEntriesInput {
  entries: ProjectUploadImportEntry[];
  targetDirectoryProjectRelativePath: string;
  overwrite?: boolean;
}

export interface ProjectPathBatchItemResult extends ProjectPathOperationResult {
  sourceProjectRelativePath: string;
  status: 'ok' | 'skipped';
}

export interface ProjectPathBatchOperationResult {
  results: ProjectPathBatchItemResult[];
}

interface PlannedExternalProjectPathImport {
  source: string;
  kind: ProjectPathKind;
  targetPath: string;
}

interface PlannedExternalUploadProjectPathImport {
  sourceProjectRelativePath: string;
  kind: ProjectPathKind;
  targetPath: string;
  content?: Uint8Array | AsyncIterable<Uint8Array>;
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

async function copySingleProjectPath(projectRoot: string, input: CopySingleProjectPathInput): Promise<ProjectPathOperationResult> {
  const sourcePath = normalizeProjectDirectoryPath(input.sourceProjectRelativePath);
  const targetDirectoryPath = normalizeProjectDirectoryPath(input.targetDirectoryProjectRelativePath);
  assertProjectTreeVisibleMutationPath(sourcePath);
  assertProjectTreeVisibleMutationPath(joinProjectPath(targetDirectoryPath, basename(sourcePath)));
  const kind = await projectPathKind(projectRoot, sourcePath);
  await assertProjectDirectory(projectRoot, targetDirectoryPath);
  if (kind === 'directory' && (targetDirectoryPath === sourcePath || targetDirectoryPath.startsWith(`${sourcePath}/`))) {
    throw new Error('Cannot copy a directory into itself or one of its descendants.');
  }
  const targetPath = await uniquePasteTargetPath(projectRoot, targetDirectoryPath, basename(sourcePath));
  await cp(resolveProjectPath(projectRoot, sourcePath), resolveProjectPath(projectRoot, targetPath), {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  return { projectRelativePath: targetPath, kind };
}

export async function copyProjectPaths(projectRoot: string, input: CopyProjectPathsInput): Promise<ProjectPathBatchOperationResult> {
  const entries = topLevelProjectPathBatchEntries(await normalizedProjectPathBatchEntries(projectRoot, input.entries));
  const results: ProjectPathBatchItemResult[] = [];
  for (const entry of entries) {
    const copied = await copySingleProjectPath(projectRoot, {
      sourceProjectRelativePath: entry.projectRelativePath,
      targetDirectoryProjectRelativePath: input.targetDirectoryProjectRelativePath
    });
    results.push({
      sourceProjectRelativePath: entry.projectRelativePath,
      projectRelativePath: copied.projectRelativePath,
      kind: copied.kind,
      status: 'ok'
    });
  }
  return { results };
}

export async function moveProjectPaths(projectRoot: string, input: MoveProjectPathsInput): Promise<ProjectPathBatchOperationResult> {
  const targetDirectoryPath = normalizeProjectDirectoryPath(input.targetDirectoryProjectRelativePath);
  await assertProjectDirectory(projectRoot, targetDirectoryPath);
  const entries = topLevelProjectPathBatchEntries(await normalizedProjectPathBatchEntries(projectRoot, input.entries));
  const plannedEntries = entries.map((entry) => ({
    entry,
    targetPath: joinProjectPath(targetDirectoryPath, basename(entry.projectRelativePath)),
    skipped: targetDirectoryPath === parentProjectPath(entry.projectRelativePath)
  }));
  assertUniqueBatchTargetPaths(plannedEntries.map((entry) => entry.targetPath));
  for (const { entry, targetPath, skipped } of plannedEntries) {
    assertProjectTreeVisibleMutationPath(targetPath);
    if (entry.kind === 'directory' && (targetDirectoryPath === entry.projectRelativePath || targetDirectoryPath.startsWith(`${entry.projectRelativePath}/`))) {
      throw new Error('Cannot move a directory into itself or one of its descendants.');
    }
    if (!skipped && await projectPathExists(projectRoot, targetPath) && input.overwrite !== true) {
      throw new Error(`Project path already exists: ${targetPath}`);
    }
  }
  const results: ProjectPathBatchItemResult[] = [];

  for (const { entry, targetPath, skipped } of plannedEntries) {
    const sourcePath = entry.projectRelativePath;
    if (skipped) {
      results.push({
        sourceProjectRelativePath: sourcePath,
        projectRelativePath: sourcePath,
        kind: entry.kind,
        status: 'skipped'
      });
      continue;
    }
    if (input.overwrite === true && await projectPathExists(projectRoot, targetPath)) {
      await rm(resolveProjectPath(projectRoot, targetPath), { recursive: true, force: false });
    }
    await rename(resolveProjectPath(projectRoot, sourcePath), resolveProjectPath(projectRoot, targetPath));
    results.push({
      sourceProjectRelativePath: sourcePath,
      projectRelativePath: targetPath,
      kind: entry.kind,
      status: 'ok'
    });
  }

  return { results };
}

export async function deleteProjectPathsPermanently(
  projectRoot: string,
  input: DeleteProjectPathsInput
): Promise<ProjectPathBatchOperationResult> {
  const entries = topLevelProjectPathBatchEntries(await normalizedProjectPathBatchEntries(projectRoot, input.entries));
  const results: ProjectPathBatchItemResult[] = [];
  for (const entry of entries) {
    await resolveExistingProjectPath(projectRoot, entry.projectRelativePath);
    await rm(resolveProjectPath(projectRoot, entry.projectRelativePath), { recursive: true, force: false });
    results.push({
      sourceProjectRelativePath: entry.projectRelativePath,
      projectRelativePath: entry.projectRelativePath,
      kind: entry.kind,
      status: 'ok'
    });
  }
  return { results };
}

export async function importExternalLocalProjectPaths(
  projectRoot: string,
  input: ImportExternalLocalProjectPathsInput
): Promise<ProjectPathBatchOperationResult> {
  const targetDirectoryPath = normalizeProjectDirectoryPath(input.targetDirectoryProjectRelativePath);
  await assertProjectDirectory(projectRoot, targetDirectoryPath);
  const plannedSources: PlannedExternalProjectPathImport[] = [];
  for (const source of input.sources) {
    if (!isAbsolute(source)) {
      throw new Error(`External source path must be absolute: ${source}`);
    }
    const sourceLinkStat = await lstat(source);
    if (sourceLinkStat.isSymbolicLink()) {
      throw new Error(`External source path must not be a symbolic link: ${source}`);
    }
    const sourceStat = await stat(source);
    const kind: ProjectPathKind = sourceStat.isDirectory() ? 'directory' : 'file';
    if (!sourceStat.isDirectory() && !sourceStat.isFile()) {
      throw new Error(`External source path is not a file or directory: ${source}`);
    }
    const targetPath = joinProjectPath(targetDirectoryPath, basename(source));
    assertProjectTreeVisibleMutationPath(targetPath);
    await assertExternalLocalImportSourceSafe(projectRoot, {
      source,
      kind,
      targetPath
    });
    plannedSources.push({ source, kind, targetPath });
  }
  assertUniqueBatchTargetPaths(plannedSources.map((entry) => entry.targetPath));
  for (const { targetPath } of plannedSources) {
    if (await projectPathExists(projectRoot, targetPath) && input.overwrite !== true) {
      throw new Error(`Project path already exists: ${targetPath}`);
    }
  }

  const results: ProjectPathBatchItemResult[] = [];
  for (const { source, kind, targetPath } of plannedSources) {
    if (input.overwrite === true && await projectPathExists(projectRoot, targetPath)) {
      await rm(resolveProjectPath(projectRoot, targetPath), { recursive: true, force: false });
    }
    await cp(source, resolveProjectPath(projectRoot, targetPath), {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    results.push({
      sourceProjectRelativePath: source,
      projectRelativePath: targetPath,
      kind,
      status: 'ok'
    });
  }
  return { results };
}

export async function importExternalUploadProjectEntries(
  projectRoot: string,
  input: ImportExternalUploadProjectEntriesInput
): Promise<ProjectPathBatchOperationResult> {
  const targetDirectoryPath = normalizeProjectDirectoryPath(input.targetDirectoryProjectRelativePath);
  await assertProjectDirectory(projectRoot, targetDirectoryPath);
  const plannedEntries = input.entries.map((entry): PlannedExternalUploadProjectPathImport => {
    const projectRelativePath = normalizeProjectDirectoryPath(entry.projectRelativePath);
    assertProjectTreeVisibleMutationPath(projectRelativePath);
    assertUploadImportEntryInsideTargetDirectory(targetDirectoryPath, projectRelativePath);
    return entry.kind === 'file'
      ? {
          sourceProjectRelativePath: projectRelativePath,
          kind: 'file',
          targetPath: projectRelativePath,
          content: entry.content
        }
      : {
          sourceProjectRelativePath: projectRelativePath,
          kind: 'directory',
          targetPath: projectRelativePath
        };
  });
  assertUniqueBatchTargetPaths(plannedEntries.map((entry) => entry.targetPath));

  const topLevelTargets = uniqueProjectPaths(plannedEntries.map((entry) => (
    uploadImportTopLevelTargetPath(targetDirectoryPath, entry.targetPath)
  )));
  for (const targetPath of topLevelTargets) {
    if (await projectPathExists(projectRoot, targetPath) && input.overwrite !== true) {
      throw new Error(`Project path already exists: ${targetPath}`);
    }
  }
  if (input.overwrite === true) {
    for (const targetPath of topLevelTargets) {
      if (await projectPathExists(projectRoot, targetPath)) {
        await rm(resolveProjectPath(projectRoot, targetPath), { recursive: true, force: false });
      }
    }
  }

  const directories = plannedEntries
    .filter((entry) => entry.kind === 'directory')
    .sort((left, right) => projectPathDepth(left.targetPath) - projectPathDepth(right.targetPath));
  for (const directory of directories) {
    await mkdir(await resolveProjectPathForWrite(projectRoot, directory.targetPath), { recursive: true });
  }
  for (const file of plannedEntries.filter((entry) => entry.kind === 'file')) {
    const absolutePath = await resolveProjectPathForWrite(projectRoot, file.targetPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeProjectUploadContent(absolutePath, file.content!);
  }

  return {
    results: plannedEntries.map((entry) => ({
      sourceProjectRelativePath: entry.sourceProjectRelativePath,
      projectRelativePath: entry.targetPath,
      kind: entry.kind,
      status: 'ok'
    }))
  };
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

function assertUniqueBatchTargetPaths(targetPaths: string[]): void {
  const seen = new Set<string>();
  for (const targetPath of targetPaths) {
    if (seen.has(targetPath)) {
      throw new Error(`Duplicate project path target in batch: ${targetPath}`);
    }
    seen.add(targetPath);
  }
}

async function writeProjectUploadContent(
  absolutePath: string,
  content: Uint8Array | AsyncIterable<Uint8Array>
): Promise<void> {
  if (content instanceof Uint8Array) {
    await writeFile(absolutePath, content);
    return;
  }

  const temporaryPath = joinFileSystemPath(dirname(absolutePath), `.debrute-upload-${randomUUID()}.tmp`);
  let moved = false;
  try {
    await pipeline(Readable.from(content), createWriteStream(temporaryPath, { flags: 'wx' }));
    await rename(temporaryPath, absolutePath);
    moved = true;
  } finally {
    if (!moved) {
      await rm(temporaryPath, { force: true });
    }
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

async function normalizedProjectPathBatchEntries(
  projectRoot: string,
  entries: ProjectPathBatchEntry[]
): Promise<ProjectPathBatchEntry[]> {
  const result: ProjectPathBatchEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const projectRelativePath = normalizeProjectDirectoryPath(entry.projectRelativePath);
    if (seen.has(projectRelativePath)) {
      continue;
    }
    assertProjectTreeVisibleMutationPath(projectRelativePath);
    const kind = await projectPathKind(projectRoot, projectRelativePath);
    if (kind !== entry.kind) {
      throw new Error(`Project path kind mismatch: ${projectRelativePath}`);
    }
    seen.add(projectRelativePath);
    result.push({ projectRelativePath, kind });
  }
  return result;
}

function uniqueProjectPaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function assertUploadImportEntryInsideTargetDirectory(targetDirectoryPath: string, projectRelativePath: string): void {
  if (!uploadImportPathRelativeToTarget(targetDirectoryPath, projectRelativePath)) {
    throw new Error(`Uploaded project path must be inside import target directory: ${projectRelativePath}`);
  }
}

function uploadImportTopLevelTargetPath(targetDirectoryPath: string, projectRelativePath: string): string {
  const relativePath = uploadImportPathRelativeToTarget(targetDirectoryPath, projectRelativePath);
  if (!relativePath) {
    throw new Error(`Uploaded project path must be inside import target directory: ${projectRelativePath}`);
  }
  return joinProjectPath(targetDirectoryPath, relativePath.split('/')[0]!);
}

function uploadImportPathRelativeToTarget(targetDirectoryPath: string, projectRelativePath: string): string | undefined {
  if (!targetDirectoryPath) {
    return projectRelativePath || undefined;
  }
  if (!projectRelativePath.startsWith(`${targetDirectoryPath}/`)) {
    return undefined;
  }
  const relativePath = projectRelativePath.slice(targetDirectoryPath.length + 1);
  return relativePath || undefined;
}

function projectPathDepth(projectRelativePath: string): number {
  return projectRelativePath.split('/').filter(Boolean).length;
}

async function assertExternalLocalImportSourceSafe(
  projectRoot: string,
  input: PlannedExternalProjectPathImport
): Promise<void> {
  const sourcePath = resolveFileSystemPath(input.source);
  const sourceRealPath = await realpath(input.source);
  const targetAbsolutePath = resolveProjectPath(projectRoot, input.targetPath);
  const targetPath = resolveFileSystemPath(targetAbsolutePath);

  if (
    input.kind === 'directory'
    && (isSameOrChildFileSystemPath(targetPath, sourcePath) || isSameOrChildFileSystemPath(targetPath, sourceRealPath))
  ) {
    throw new Error('Cannot import a project directory into itself or one of its descendants.');
  }

  if (!await projectPathExists(projectRoot, input.targetPath)) {
    return;
  }
  const targetRealPath = await realpath(targetAbsolutePath);
  if (targetRealPath === sourceRealPath) {
    throw new Error(`External source path resolves to its project import target: ${input.targetPath}`);
  }
}

function topLevelProjectPathBatchEntries(entries: ProjectPathBatchEntry[]): ProjectPathBatchEntry[] {
  const result: ProjectPathBatchEntry[] = [];
  for (const entry of entries) {
    if (result.some((candidate) => isSameOrChildProjectPath(entry.projectRelativePath, candidate.projectRelativePath))) {
      continue;
    }
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (isSameOrChildProjectPath(result[index]!.projectRelativePath, entry.projectRelativePath)) {
        result.splice(index, 1);
      }
    }
    result.push(entry);
  }
  return result;
}

async function projectPathExists(projectRoot: string, projectRelativePath: string): Promise<boolean> {
  try {
    await stat(await resolveProjectPathForWrite(projectRoot, projectRelativePath));
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
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

function isSameOrChildProjectPath(projectRelativePath: string, parentPath: string): boolean {
  return projectRelativePath === parentPath || projectRelativePath.startsWith(`${parentPath}/`);
}

function isSameOrChildFileSystemPath(candidatePath: string, parentPath: string): boolean {
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}${sep}`);
}
