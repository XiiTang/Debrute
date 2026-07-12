import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import { projectContentHash, resolveNoSymlinkProjectPathForWrite } from '@debrute/project-core';
import { documentServiceError } from './ProjectDocumentDiagnostics.js';
import { projectDocumentDescriptorForPath } from './documentDescriptors.js';

export interface ProjectDocumentReadParticipant {
  absolutePath: string;
  expectedHash: string | null;
}

export interface ProjectDocumentWrite {
  absolutePath: string;
  content: string;
  recordInternalWrite?: (absolutePath: string, content: string) => void;
  forgetInternalWrite?: (absolutePath: string) => void;
}

export interface ProjectDocumentDelete {
  absolutePath: string;
  recordInternalWrite?: (absolutePath: string) => void;
  forgetInternalWrite?: (absolutePath: string) => void;
}

export interface ProjectDocumentTransactionInput {
  projectRoot: string;
  owner: string;
  reads: ProjectDocumentReadParticipant[];
  writes?: ProjectDocumentWrite[];
  deletes?: ProjectDocumentDelete[];
}

interface ProjectDocumentLock {
  lockPath: string;
  handle: FileHandle;
}

interface ResolvedProjectDocumentReadParticipant extends ProjectDocumentReadParticipant {
  resolvedAbsolutePath: string;
}

interface ResolvedProjectDocumentWrite extends ProjectDocumentWrite {
  resolvedAbsolutePath: string;
}

interface ResolvedProjectDocumentDelete extends ProjectDocumentDelete {
  resolvedAbsolutePath: string;
}

export async function projectDocumentFileHash(absolutePath: string): Promise<string | null> {
  try {
    const content = await readFile(absolutePath);
    return projectContentHash(content);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

export function projectDocumentTextHash(content: string): string {
  return projectContentHash(content);
}

export async function commitProjectDocumentTransaction(input: ProjectDocumentTransactionInput): Promise<void> {
  const writes = input.writes ?? [];
  const deletes = input.deletes ?? [];
  let resolvedReads: ResolvedProjectDocumentReadParticipant[] = [];
  let resolvedWrites: ResolvedProjectDocumentWrite[] = [];
  let resolvedDeletes: ResolvedProjectDocumentDelete[] = [];
  const stagedWrites: Array<{ tempPath: string; finalPath: string }> = [];
  const backups = new Map<string, Buffer | null>();
  let locks: ProjectDocumentLock[] = [];
  let transactionError: unknown;
  let cleanupError: unknown;
  let releaseError: unknown;
  try {
    try {
      resolvedWrites = await resolveProjectDocumentWrites(input.projectRoot, input.owner, writes);
      resolvedDeletes = await resolveProjectDocumentDeletes(input.projectRoot, input.owner, deletes);
      resolvedReads = await resolveProjectDocumentReads(input.projectRoot, input.reads);
      assertUniqueTargets(resolvedWrites, resolvedDeletes);
      locks = await acquireProjectDocumentLocks(input.projectRoot, resolvedReads, resolvedWrites, resolvedDeletes);
      for (const absolutePath of affectedResolvedPaths(resolvedWrites, resolvedDeletes)) {
        backups.set(absolutePath, await readExistingFileForRollback(absolutePath));
      }

      for (const read of resolvedReads) {
        const currentHash = await projectDocumentFileHash(read.resolvedAbsolutePath);
        if (currentHash !== read.expectedHash) {
          throw documentServiceError('document_push_conflict', 'Project document changed on disk before push commit.', {
            file_path: read.absolutePath
          });
        }
      }

      for (const write of resolvedWrites) {
        await mkdir(dirname(write.resolvedAbsolutePath), { recursive: true });
        const tempPath = `${write.resolvedAbsolutePath}.${randomUUID()}.tmp`;
        await writeFile(tempPath, write.content, 'utf8');
        stagedWrites.push({ tempPath, finalPath: write.resolvedAbsolutePath });
      }

      for (const [index, write] of resolvedWrites.entries()) {
        write.recordInternalWrite?.(write.resolvedAbsolutePath, write.content);
        await rename(stagedWrites[index]!.tempPath, write.resolvedAbsolutePath);
      }

      for (const deleteItem of resolvedDeletes) {
        deleteItem.recordInternalWrite?.(deleteItem.resolvedAbsolutePath);
        await rm(deleteItem.resolvedAbsolutePath, { force: true });
      }
    } catch (error) {
      if (isProjectDocumentServiceError(error)) {
        transactionError = error;
      } else {
        transactionError = documentServiceError('document_push_failed', errorMessage(error));
      }
      cleanupError = await abortProjectDocumentTransaction(backups, resolvedWrites, resolvedDeletes, stagedWrites);
    }
  } finally {
    try {
      await releaseProjectDocumentLocks(locks);
    } catch (error) {
      releaseError = error;
    }
  }
  if (transactionError) {
    if (cleanupError) {
      throw documentServiceError(
        'document_push_failed',
        `${errorMessage(transactionError)} Rollback cleanup failed: ${errorMessage(cleanupError)}`
      );
    }
    throw transactionError;
  }
  if (releaseError) {
    throw documentServiceError('document_push_failed', errorMessage(releaseError));
  }
}

async function abortProjectDocumentTransaction(
  backups: Map<string, Buffer | null>,
  writes: ResolvedProjectDocumentWrite[],
  deletes: ResolvedProjectDocumentDelete[],
  stagedWrites: Array<{ tempPath: string }>
): Promise<unknown> {
  let cleanupError: unknown;
  try {
    await restoreProjectDocumentBackups(backups, writes, deletes);
  } catch (error) {
    cleanupError ??= error;
  }
  for (const write of writes) {
    try {
      write.forgetInternalWrite?.(write.resolvedAbsolutePath);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  for (const deleteItem of deletes) {
    try {
      deleteItem.forgetInternalWrite?.(deleteItem.resolvedAbsolutePath);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  try {
    await Promise.all(stagedWrites.map((item) => rm(item.tempPath, { force: true })));
  } catch (error) {
    cleanupError ??= error;
  }
  return cleanupError;
}

async function resolveProjectDocumentWrites(
  projectRoot: string,
  owner: string,
  writes: ProjectDocumentWrite[]
): Promise<ResolvedProjectDocumentWrite[]> {
  return Promise.all(writes.map(async (write) => ({
    ...write,
    resolvedAbsolutePath: await resolveProjectDocumentMutationPath(projectRoot, owner, write.absolutePath)
  })));
}

async function resolveProjectDocumentDeletes(
  projectRoot: string,
  owner: string,
  deletes: ProjectDocumentDelete[]
): Promise<ResolvedProjectDocumentDelete[]> {
  return Promise.all(deletes.map(async (deleteItem) => ({
    ...deleteItem,
    resolvedAbsolutePath: await resolveProjectDocumentMutationPath(projectRoot, owner, deleteItem.absolutePath)
  })));
}

async function resolveProjectDocumentMutationPath(projectRoot: string, owner: string, absolutePath: string): Promise<string> {
  const projectRelativePath = await projectRelativeDocumentPath(projectRoot, absolutePath);
  const descriptor = projectDocumentDescriptorForPath(projectRelativePath);
  if (!descriptor) {
    throw documentServiceError('document_descriptor_violation', 'Project document path is not registered.', {
      file_path: absolutePath
    });
  }
  if (!descriptor.owners.includes(owner)) {
    throw documentServiceError('document_descriptor_violation', 'Project document owner is not allowed to write this document.', {
      file_path: absolutePath,
      owner,
      document_type: descriptor.type
    });
  }
  return resolveNoSymlinkProjectPathForWrite(projectRoot, projectRelativePath);
}

async function resolveProjectDocumentReads(
  projectRoot: string,
  reads: ProjectDocumentReadParticipant[]
): Promise<ResolvedProjectDocumentReadParticipant[]> {
  return Promise.all(reads.map(async (read) => ({
    ...read,
    resolvedAbsolutePath: await resolveProjectDocumentReadPath(projectRoot, read.absolutePath)
  })));
}

async function resolveProjectDocumentReadPath(projectRoot: string, absolutePath: string): Promise<string> {
  const relativePath = await projectRelativeDocumentPath(projectRoot, absolutePath);
  if (projectDocumentDescriptorForPath(relativePath) === undefined) {
    throw documentServiceError('document_descriptor_violation', 'Project document path is not registered.', {
      file_path: absolutePath
    });
  }
  return resolveNoSymlinkProjectPathForWrite(projectRoot, relativePath);
}

function assertUniqueTargets(writes: ResolvedProjectDocumentWrite[], deletes: ResolvedProjectDocumentDelete[]): void {
  const seen = new Set<string>();
  for (const operation of [...writes, ...deletes]) {
    if (seen.has(operation.resolvedAbsolutePath)) {
      throw documentServiceError('document_descriptor_violation', 'Project document transaction contains duplicate targets.', {
        file_path: operation.absolutePath
      });
    }
    seen.add(operation.resolvedAbsolutePath);
  }
}

function affectedResolvedPaths(writes: ResolvedProjectDocumentWrite[], deletes: ResolvedProjectDocumentDelete[]): string[] {
  return [
    ...writes.map((write) => write.resolvedAbsolutePath),
    ...deletes.map((deleteItem) => deleteItem.resolvedAbsolutePath)
  ];
}

async function acquireProjectDocumentLocks(
  projectRoot: string,
  reads: ResolvedProjectDocumentReadParticipant[],
  writes: ResolvedProjectDocumentWrite[],
  deletes: ResolvedProjectDocumentDelete[]
): Promise<ProjectDocumentLock[]> {
  const locks: ProjectDocumentLock[] = [];
  try {
    for (const absolutePath of lockableDocumentPaths(projectRoot, reads, writes, deletes)) {
      await mkdir(dirname(absolutePath), { recursive: true });
      const lockPath = `${absolutePath}.lock`;
      try {
        const handle = await open(lockPath, 'wx');
        locks.push({ lockPath, handle });
      } catch (error) {
        if (isFileExistsError(error)) {
          throw documentServiceError('document_push_conflict', 'Project document is locked by another writer.', {
            file_path: absolutePath
          });
        }
        throw error;
      }
    }
    return locks;
  } catch (error) {
    await releaseProjectDocumentLocks(locks).catch(() => undefined);
    throw error;
  }
}

function lockableDocumentPaths(
  projectRoot: string,
  reads: ResolvedProjectDocumentReadParticipant[],
  writes: ResolvedProjectDocumentWrite[],
  deletes: ResolvedProjectDocumentDelete[]
): string[] {
  const paths = new Set<string>(affectedResolvedPaths(writes, deletes));
  for (const read of reads) {
    if (isRegisteredProjectDocumentPath(projectRoot, read.absolutePath)) {
      paths.add(read.resolvedAbsolutePath);
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function isRegisteredProjectDocumentPath(projectRoot: string, absolutePath: string): boolean {
  const relativePath = projectRelativeDocumentPathIfInside(projectRoot, absolutePath);
  return relativePath !== undefined && projectDocumentDescriptorForPath(relativePath) !== undefined;
}

async function releaseProjectDocumentLocks(locks: ProjectDocumentLock[]): Promise<void> {
  let releaseError: unknown;
  for (const lock of [...locks].reverse()) {
    try {
      await lock.handle.close();
    } catch (error) {
      releaseError ??= error;
    }
    try {
      await rm(lock.lockPath, { force: true });
    } catch (error) {
      releaseError ??= error;
    }
  }
  if (releaseError) {
    throw releaseError;
  }
}

async function readExistingFileForRollback(absolutePath: string): Promise<Buffer | null> {
  try {
    return await readFile(absolutePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

async function restoreProjectDocumentBackups(
  backups: Map<string, Buffer | null>,
  writes: ResolvedProjectDocumentWrite[],
  deletes: ResolvedProjectDocumentDelete[]
): Promise<void> {
  const operationByPath = new Map<string, ResolvedProjectDocumentWrite | ResolvedProjectDocumentDelete>();
  for (const write of writes) {
    operationByPath.set(write.resolvedAbsolutePath, write);
  }
  for (const deleteItem of deletes) {
    operationByPath.set(deleteItem.resolvedAbsolutePath, deleteItem);
  }
  await Promise.all([...backups.entries()].map(async ([absolutePath, content]) => {
    const operation = operationByPath.get(absolutePath);
    if (content === null) {
      recordRollbackWrite(operation, absolutePath);
      await rm(absolutePath, { force: true });
      return;
    }
    await mkdir(dirname(absolutePath), { recursive: true });
    const tempPath = `${absolutePath}.${randomUUID()}.restore.tmp`;
    await writeFile(tempPath, content);
    recordRollbackWrite(operation, absolutePath, content.toString('utf8'));
    await rename(tempPath, absolutePath);
  }));
}

function recordRollbackWrite(
  operation: ResolvedProjectDocumentWrite | ResolvedProjectDocumentDelete | undefined,
  absolutePath: string,
  content?: string
): void {
  if (!operation?.recordInternalWrite) {
    return;
  }
  if (content === undefined) {
    (operation.recordInternalWrite as (path: string) => void)(absolutePath);
    return;
  }
  (operation.recordInternalWrite as (path: string, content: string) => void)(absolutePath, content);
}

async function projectRelativeDocumentPath(projectRoot: string, absolutePath: string): Promise<string> {
  const lexicalRelativePath = projectRelativeDocumentPathIfInside(projectRoot, absolutePath);
  if (lexicalRelativePath) {
    return lexicalRelativePath;
  }

  const projectRootRealPath = await realpath(projectRoot);
  const canonicalRelativePath = projectRelativeDocumentPathIfInside(projectRootRealPath, absolutePath);
  if (canonicalRelativePath) {
    return canonicalRelativePath;
  }

  const targetRealPath = await realpathIfExisting(absolutePath);
  if (targetRealPath) {
    const targetRelativePath = projectRelativeDocumentPathIfInside(projectRootRealPath, targetRealPath);
    if (targetRelativePath) {
      return targetRelativePath;
    }
  }

  throw documentServiceError('document_descriptor_violation', 'Project document path is outside the project root.', {
    file_path: absolutePath
  });
}

function projectRelativeDocumentPathIfInside(projectRoot: string, absolutePath: string): string | undefined {
  const relativePath = relative(projectRoot, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath.replaceAll('\\', '/');
}

async function realpathIfExisting(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
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

function isFileExistsError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'EEXIST';
}

function isProjectDocumentServiceError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && error.code.startsWith('document_');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
