import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import { documentServiceError } from './ProjectDocumentDiagnostics.js';
import { projectDocumentDescriptorForPath } from './documentDescriptors.js';

export interface ProjectDocumentReadParticipant {
  absolutePath: string;
  expectedHash: string | null;
}

export interface ProjectDocumentWrite {
  absolutePath: string;
  content: string;
  suppressInternalEvent?: (absolutePath: string, content: string) => void;
  clearInternalEvent?: (absolutePath: string) => void;
}

export interface ProjectDocumentDelete {
  absolutePath: string;
  suppressInternalEvent?: (absolutePath: string) => void;
  clearInternalEvent?: (absolutePath: string) => void;
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

export async function projectDocumentFileHash(absolutePath: string): Promise<string | null> {
  try {
    const content = await readFile(absolutePath);
    return projectDocumentBufferHash(content);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

export function projectDocumentTextHash(content: string): string {
  return projectDocumentBufferHash(Buffer.from(content, 'utf8'));
}

export async function commitProjectDocumentTransaction(input: ProjectDocumentTransactionInput): Promise<void> {
  const writes = input.writes ?? [];
  const deletes = input.deletes ?? [];
  const stagedWrites: Array<{ tempPath: string; finalPath: string }> = [];
  const backups = new Map<string, Buffer | null>();
  let locks: ProjectDocumentLock[] = [];
  let transactionError: unknown;
  try {
    validateProjectDocumentTargets(input.projectRoot, input.owner, writes, deletes);
    assertUniqueTargets(writes, deletes);
    locks = await acquireProjectDocumentLocks(input.projectRoot, input.reads, writes, deletes);
    for (const absolutePath of affectedPaths(writes, deletes)) {
      backups.set(absolutePath, await readExistingFileForRollback(absolutePath));
    }

    for (const read of input.reads) {
      const currentHash = await projectDocumentFileHash(read.absolutePath);
      if (currentHash !== read.expectedHash) {
        throw documentServiceError('document_push_conflict', 'Project document changed on disk before push commit.', {
          file_path: read.absolutePath
        });
      }
    }

    for (const write of writes) {
      await mkdir(dirname(write.absolutePath), { recursive: true });
      const tempPath = `${write.absolutePath}.${randomUUID()}.tmp`;
      await writeFile(tempPath, write.content, 'utf8');
      stagedWrites.push({ tempPath, finalPath: write.absolutePath });
    }

    for (const [index, write] of writes.entries()) {
      write.suppressInternalEvent?.(write.absolutePath, write.content);
      await rename(stagedWrites[index]!.tempPath, write.absolutePath);
    }

    for (const deleteItem of deletes) {
      deleteItem.suppressInternalEvent?.(deleteItem.absolutePath);
      await rm(deleteItem.absolutePath, { force: true });
    }
  } catch (error) {
    await restoreProjectDocumentBackups(backups, writes, deletes);
    for (const write of writes) {
      write.clearInternalEvent?.(write.absolutePath);
    }
    for (const deleteItem of deletes) {
      deleteItem.clearInternalEvent?.(deleteItem.absolutePath);
    }
    await Promise.all(stagedWrites.map((item) => rm(item.tempPath, { force: true })));
    if (isProjectDocumentServiceError(error)) {
      transactionError = error;
    } else {
      transactionError = documentServiceError('document_push_failed', errorMessage(error));
    }
  }

  let releaseError: unknown;
  try {
    await releaseProjectDocumentLocks(locks);
  } catch (error) {
    releaseError = error;
  }
  if (transactionError) {
    throw transactionError;
  }
  if (releaseError) {
    throw documentServiceError('document_push_failed', errorMessage(releaseError));
  }
}

function projectDocumentBufferHash(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function validateProjectDocumentTargets(
  projectRoot: string,
  owner: string,
  writes: ProjectDocumentWrite[],
  deletes: ProjectDocumentDelete[]
): void {
  for (const absolutePath of affectedPaths(writes, deletes)) {
    const projectRelativePath = projectRelativeDocumentPath(projectRoot, absolutePath);
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
  }
}

function assertUniqueTargets(writes: ProjectDocumentWrite[], deletes: ProjectDocumentDelete[]): void {
  const seen = new Set<string>();
  for (const absolutePath of affectedPaths(writes, deletes)) {
    if (seen.has(absolutePath)) {
      throw documentServiceError('document_descriptor_violation', 'Project document transaction contains duplicate targets.', {
        file_path: absolutePath
      });
    }
    seen.add(absolutePath);
  }
}

function affectedPaths(writes: ProjectDocumentWrite[], deletes: ProjectDocumentDelete[]): string[] {
  return [
    ...writes.map((write) => write.absolutePath),
    ...deletes.map((deleteItem) => deleteItem.absolutePath)
  ];
}

async function acquireProjectDocumentLocks(
  projectRoot: string,
  reads: ProjectDocumentReadParticipant[],
  writes: ProjectDocumentWrite[],
  deletes: ProjectDocumentDelete[]
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
  reads: ProjectDocumentReadParticipant[],
  writes: ProjectDocumentWrite[],
  deletes: ProjectDocumentDelete[]
): string[] {
  const paths = new Set<string>(affectedPaths(writes, deletes));
  for (const read of reads) {
    if (isRegisteredProjectDocumentPath(projectRoot, read.absolutePath)) {
      paths.add(read.absolutePath);
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
  writes: ProjectDocumentWrite[],
  deletes: ProjectDocumentDelete[]
): Promise<void> {
  const operationByPath = new Map<string, ProjectDocumentWrite | ProjectDocumentDelete>();
  for (const write of writes) {
    operationByPath.set(write.absolutePath, write);
  }
  for (const deleteItem of deletes) {
    operationByPath.set(deleteItem.absolutePath, deleteItem);
  }
  await Promise.all([...backups.entries()].map(async ([absolutePath, content]) => {
    const operation = operationByPath.get(absolutePath);
    if (content === null) {
      suppressRollbackEvent(operation, absolutePath);
      await rm(absolutePath, { force: true });
      return;
    }
    await mkdir(dirname(absolutePath), { recursive: true });
    const tempPath = `${absolutePath}.${randomUUID()}.restore.tmp`;
    await writeFile(tempPath, content);
    suppressRollbackEvent(operation, absolutePath, content.toString('utf8'));
    await rename(tempPath, absolutePath);
  }));
}

function suppressRollbackEvent(
  operation: ProjectDocumentWrite | ProjectDocumentDelete | undefined,
  absolutePath: string,
  content?: string
): void {
  if (!operation?.suppressInternalEvent) {
    return;
  }
  if (content === undefined) {
    (operation.suppressInternalEvent as (path: string) => void)(absolutePath);
    return;
  }
  (operation.suppressInternalEvent as (path: string, content: string) => void)(absolutePath, content);
}

function projectRelativeDocumentPath(projectRoot: string, absolutePath: string): string {
  const relativePath = relative(projectRoot, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw documentServiceError('document_descriptor_violation', 'Project document path is outside the project root.', {
      file_path: absolutePath
    });
  }
  return relativePath.replaceAll('\\', '/');
}

function projectRelativeDocumentPathIfInside(projectRoot: string, absolutePath: string): string | undefined {
  const relativePath = relative(projectRoot, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath.replaceAll('\\', '/');
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
