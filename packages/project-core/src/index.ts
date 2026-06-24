import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertProjectTreeVisibleMutationPath,
  debruteHomeDir,
  isIgnoredProjectFilePath,
  normalizeProjectRelativePath,
  resolveExistingProjectPath,
  resolveProjectPathForWrite,
  resolveProjectPath
} from './projectPaths.js';
import {
  projectTextLanguageFromPath,
  projectTextMimeTypeFromPath,
  type ProjectTextLanguageId
} from './projectTextFileTypes.js';

export const DEBRUTE_PROJECT_SCHEMA_VERSION = 1;

export interface ProjectIdentity {
  id: string;
  name: string;
  rootPath: string;
}

export interface DebruteProjectMetadata {
  schemaVersion: number;
  project: {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  };
}

export interface DebruteProjectPaths {
  debruteDir: string;
  projectFile: string;
  canvasesDir: string;
  canvasMapsDir: string;
  canvasIndexFile: string;
  globalRuntimeDir: string;
}

export interface ProjectFileEntry {
  projectRelativePath: string;
  kind: 'file' | 'directory';
}

export interface ProjectTextFile {
  projectRelativePath: string;
  absolutePath: string;
  content: string;
  size: number;
  mtimeMs: number;
  revision: string;
  language: ProjectTextLanguageId;
  mimeType: string;
}

export interface ProjectFileWatchHandle {
  close(): void;
}

export interface NormalizedFileWatchEvent {
  type: 'changed';
  absolutePath: string;
  projectRelativePath: string;
  observedAt?: number;
  affects: Array<'canvas' | 'canvas-registry' | 'canvas-map' | 'canvas-feedback' | 'project-metadata' | 'generated-asset-metadata' | 'content'>;
}

export function createProjectIdentity(projectRoot: string, name = basenameFromPath(projectRoot)): ProjectIdentity {
  return {
    id: randomUUID(),
    name,
    rootPath: projectRoot
  };
}

export function getDebruteProjectPaths(projectRoot: string): DebruteProjectPaths {
  const debruteDir = join(projectRoot, '.debrute');
  return {
    debruteDir,
    projectFile: join(debruteDir, 'project.json'),
    canvasesDir: join(debruteDir, 'canvases'),
    canvasMapsDir: join(debruteDir, 'canvas-maps'),
    canvasIndexFile: join(debruteDir, 'canvases/index.json'),
    globalRuntimeDir: join(debruteHomeDir(), 'runtime')
  };
}

export async function initializeBlankProject(projectRoot: string, options: { name?: string } = {}): Promise<DebruteProjectMetadata> {
  const paths = getDebruteProjectPaths(projectRoot);
  await mkdir(paths.canvasesDir, { recursive: true });

  const now = new Date().toISOString();
  const identity = createProjectIdentity(projectRoot, options.name);
  const metadata: DebruteProjectMetadata = {
    schemaVersion: DEBRUTE_PROJECT_SCHEMA_VERSION,
    project: {
      id: identity.id,
      name: identity.name,
      createdAt: now,
      updatedAt: now
    }
  };

  await writeJsonAtomic(paths.projectFile, metadata);
  return metadata;
}

export async function readProjectMetadata(projectRoot: string): Promise<DebruteProjectMetadata> {
  const metadata = await readJsonFile<DebruteProjectMetadata>(getDebruteProjectPaths(projectRoot).projectFile);
  assertProjectSchema(metadata);
  return metadata;
}

export async function listDebruteProjectFiles(projectRoot: string): Promise<ProjectFileEntry[]> {
  const entries = await walkEntries(projectRoot);
  return entries
    .filter((entry) => !entry.projectRelativePath.startsWith('.git/'))
    .filter((entry) => !isIgnoredProjectFilePath(entry.projectRelativePath))
    .sort((a, b) => a.projectRelativePath.localeCompare(b.projectRelativePath));
}

export function watchProjectFiles(
  projectRoot: string,
  onEvent: (event: NormalizedFileWatchEvent) => void,
  options: { debounceMs?: number } = {}
): ProjectFileWatchHandle {
  const debounceMs = options.debounceMs ?? 40;
  const timers = new Map<string, NodeJS.Timeout>();
  const watcher = watch(projectRoot, { recursive: true }, (_eventType, fileName) => {
    if (!fileName) {
      return;
    }
    const projectRelativePath = String(fileName).replaceAll('\\', '/');
    if (projectRelativePath.startsWith('.git/') || isIgnoredProjectFilePath(projectRelativePath) || projectRelativePath.includes('.tmp')) {
      return;
    }
    const observedAt = Date.now();
    const absolutePath = join(projectRoot, projectRelativePath);
    const type = 'changed';
    const key = `${type}:${absolutePath}`;
    const existing = timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      onEvent(normalizeFileWatchEvent(projectRoot, absolutePath, type, observedAt));
    }, debounceMs));
  });

  return {
    close() {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      watcher.close();
    }
  };
}

export async function readTextFile(absolutePath: string): Promise<string> {
  return readFile(absolutePath, 'utf8');
}

export async function readProjectTextFile(projectRoot: string, projectRelativePath: string, options: { maxBytes?: number } = {}): Promise<ProjectTextFile> {
  const absolutePath = await resolveExistingProjectPath(projectRoot, projectRelativePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error(`Project path is not a file: ${projectRelativePath}`);
  }
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  if (fileStat.size > maxBytes) {
    throw new Error(`Project file is too large to open as text (${fileStat.size} bytes): ${projectRelativePath}`);
  }
  const bytes = await readFile(absolutePath);
  if (isProbablyBinary(bytes)) {
    throw new Error(`Project file appears to be binary, not text: ${projectRelativePath}`);
  }
  const content = bytes.toString('utf8');
  if (content.includes('\uFFFD')) {
    throw new Error(`Project file is not valid UTF-8 text: ${projectRelativePath}`);
  }
  const firstLine = firstLineOf(content);
  return {
    projectRelativePath: normalizeProjectRelativePath(projectRelativePath),
    absolutePath,
    content,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    revision: projectFileRevision(fileStat.size, fileStat.mtimeMs),
    language: projectTextLanguageFromPath(projectRelativePath, firstLine),
    mimeType: projectTextMimeTypeFromPath(projectRelativePath, firstLine)
  };
}

export async function readProjectFileBytes(projectRoot: string, projectRelativePath: string, options: { maxBytes?: number } = {}): Promise<Uint8Array> {
  const absolutePath = await resolveExistingProjectPath(projectRoot, projectRelativePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error(`Project path is not a file: ${projectRelativePath}`);
  }
  if (options.maxBytes !== undefined && fileStat.size > options.maxBytes) {
    throw new Error(`Project file is too large to read (${fileStat.size} bytes): ${projectRelativePath}`);
  }
  return readFile(absolutePath);
}

export async function writeProjectFile(
  projectRoot: string,
  projectRelativePath: string,
  content: string | Uint8Array,
  options: { signal?: AbortSignal } = {}
): Promise<string> {
  assertProjectTreeVisibleMutationPath(projectRelativePath);
  const absolutePath = await resolveProjectPathForWrite(projectRoot, projectRelativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, options.signal ? { signal: options.signal } : undefined);
  return normalizeProjectRelativePath(projectRelativePath);
}

export async function writeProjectTextFile(projectRoot: string, projectRelativePath: string, content: string): Promise<ProjectTextFile> {
  await writeProjectFile(projectRoot, projectRelativePath, content);
  return readProjectTextFile(projectRoot, projectRelativePath);
}

export {
  copyProjectPaths,
  createProjectDirectory,
  createProjectFile,
  deleteProjectPathsPermanently,
  importExternalLocalProjectPaths,
  importExternalUploadProjectEntries,
  moveProjectPaths,
  nextCopyProjectPathName,
  renameProjectPath,
  uniquePasteTargetPath,
  type CopyProjectPathsInput,
  type CreateProjectPathInput,
  type DeleteProjectPathsInput,
  type ImportExternalLocalProjectPathsInput,
  type ImportExternalUploadProjectEntriesInput,
  type MoveProjectPathsInput,
  type ProjectPathBatchEntry,
  type ProjectPathBatchItemResult,
  type ProjectPathBatchOperationResult,
  type ProjectPathKind,
  type ProjectUploadImportEntry,
  type ProjectPathOperationResult,
  type RenameProjectPathInput
} from './projectFileOperations.js';

export {
  ADOBE_BRIDGE_MAX_UPLOAD_BYTES,
  AdobeBridgeProjectFileError,
  importAdobeBridgePngTransfer,
  isSupportedAdobeBridgeProjectImageFile,
  nextAdobeBridgeTransferFileName,
  sanitizeAdobeBridgePngBasename,
  type AdobeBridgeProjectFileErrorCode,
  type AdobeBridgeProjectFileResult,
  type ImportAdobeBridgePngTransferInput
} from './adobeBridgeFileTransfer.js';

export {
  isCanvasPreviewableProjectImagePath,
  isProjectImageReferencePath,
  isSupportedProjectImagePath,
  projectImageExtensionForMimeType,
  projectImageFileTypeForPath,
  projectImageMimeTypeFromDataUrl,
  projectImageMimeTypeFromPath,
  type ProjectImageFileType,
  type ProjectImageMimeType
} from './projectImageFileTypes.js';

export {
  isKnownProjectTextFilePath,
  projectTextFileTypeForPath,
  projectTextLanguageFromPath,
  projectTextMimeTypeFromPath,
  type ProjectTextFileType,
  type ProjectTextLanguageId
} from './projectTextFileTypes.js';

export {
  assertProjectTreeVisibleMutationPath,
  debruteHomeDir,
  isIgnoredProjectFilePath,
  isProtectedProjectDocumentMutationPath,
  joinProjectPath,
  normalizeProjectDirectoryPath,
  normalizeProjectPathBasename,
  normalizeProjectRelativePath,
  parentProjectPath,
  resolveExistingProjectPath,
  resolveNoSymlinkExistingProjectPath,
  resolveNoSymlinkProjectPathForWrite,
  resolveProjectPathForWrite,
  resolveProjectPath,
  userHomeDir
} from './projectPaths.js';

export async function readJsonFile<T>(absolutePath: string): Promise<T> {
  const content = await readTextFile(absolutePath);
  return JSON.parse(content) as T;
}

export function projectFileRevision(size: number, mtimeMs: number): string {
  return `${Math.round(mtimeMs)}:${size}`;
}

export async function writeJsonAtomic(absolutePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, absolutePath);
}

export function normalizeFileWatchEvent(projectRoot: string, absolutePath: string, type: NormalizedFileWatchEvent['type'], observedAt?: number): NormalizedFileWatchEvent {
  const projectRelativePath = relative(projectRoot, absolutePath).replaceAll('\\', '/');
  const affects: NormalizedFileWatchEvent['affects'] = [];

  if (isIgnoredProjectFilePath(projectRelativePath)) {
    return {
      type,
      absolutePath,
      projectRelativePath,
      ...(observedAt === undefined ? {} : { observedAt }),
      affects
    };
  }
  if (projectRelativePath === '.debrute/canvases/index.json') {
    affects.push('canvas-registry');
  } else if (projectRelativePath.startsWith('.debrute/canvases/') && projectRelativePath.endsWith('.json')) {
    affects.push('canvas');
  } else if (projectRelativePath.startsWith('.debrute/canvas-maps/') && projectRelativePath.endsWith('.yaml')) {
    affects.push('canvas-map');
  } else if (projectRelativePath === '.debrute/reviews/canvas-feedback.json') {
    affects.push('canvas-feedback');
  } else if (projectRelativePath === '.debrute/project.json') {
    affects.push('project-metadata');
  } else if (
    projectRelativePath === '.debrute/assets/generated-assets-index.json'
    || projectRelativePath.startsWith('.debrute/assets/generated/')
    || projectRelativePath === '.debrute/cache/file-fingerprints.json'
  ) {
    affects.push('generated-asset-metadata');
  } else {
    affects.push('content');
  }

  return {
    type,
    absolutePath,
    projectRelativePath,
    ...(observedAt === undefined ? {} : { observedAt }),
    affects
  };
}

export function assertProjectSchema(metadata: DebruteProjectMetadata): void {
  if (metadata.schemaVersion !== DEBRUTE_PROJECT_SCHEMA_VERSION) {
    throw new Error(`Unsupported Debrute project schema ${metadata.schemaVersion}. Expected ${DEBRUTE_PROJECT_SCHEMA_VERSION}.`);
  }
}

async function walkEntries(root: string, prefix = ''): Promise<ProjectFileEntry[]> {
  let directoryEntries;
  try {
    directoryEntries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const collected: ProjectFileEntry[] = [];
  for (const entry of directoryEntries) {
    const projectRelativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (isIgnoredProjectFilePath(projectRelativePath)) {
        continue;
      }
      collected.push({ projectRelativePath, kind: 'directory' });
      collected.push(...await walkEntries(root, projectRelativePath));
    } else if (entry.isFile()) {
      collected.push({ projectRelativePath, kind: 'file' });
    }
  }
  return collected;
}

function basenameFromPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'Untitled Project';
}

function firstLineOf(content: string): string {
  return content.split(/\r?\n/, 1)[0] ?? '';
}

function isProbablyBinary(bytes: Uint8Array): boolean {
  const sampleLength = Math.min(bytes.byteLength, 8192);
  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
