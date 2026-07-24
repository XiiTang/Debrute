import type { DebruteShellApi } from '../../api/shellApi';

export type ProjectTreeExternalUploadEntry =
  | {
      kind: 'directory';
      projectRelativePath: string;
    }
  | {
      kind: 'file';
      file: File;
      projectRelativePath: string;
    };

export interface ProjectTreeExternalDropPlan {
  localPaths: string[];
  uploads: ProjectTreeExternalUploadEntry[];
  targetDirectoryProjectRelativePath: string;
}

export function hasProjectTreeExternalDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).includes('Files');
}

export async function createProjectTreeExternalDropPlan(input: {
  dataTransfer: DataTransfer;
  shell: DebruteShellApi | undefined;
  targetDirectoryProjectRelativePath: string;
}): Promise<ProjectTreeExternalDropPlan> {
  const files = Array.from(input.dataTransfer.files);
  const electronLocalPaths = electronLocalDropPaths(files, input.shell);
  if (electronLocalPaths) {
    return {
      localPaths: electronLocalPaths,
      uploads: [],
      targetDirectoryProjectRelativePath: normalizeExternalDropPath(input.targetDirectoryProjectRelativePath)
    };
  }

  const entryUploads = await browserEntryUploadEntries(input.dataTransfer, input.targetDirectoryProjectRelativePath);
  if (entryUploads.length > 0) {
    return {
      localPaths: [],
      uploads: entryUploads,
      targetDirectoryProjectRelativePath: normalizeExternalDropPath(input.targetDirectoryProjectRelativePath)
    };
  }

  return {
    localPaths: [],
    uploads: files.map((file) => ({
      kind: 'file',
      file,
      projectRelativePath: joinExternalDropPath(
        input.targetDirectoryProjectRelativePath,
        browserFileProjectRelativePath(file)
      )
    })),
    targetDirectoryProjectRelativePath: normalizeExternalDropPath(input.targetDirectoryProjectRelativePath)
  };
}

function electronLocalDropPaths(files: File[], shell: DebruteShellApi | undefined): string[] | undefined {
  if (!shell || files.length === 0) {
    return undefined;
  }
  const paths = files.map((file) => shell.getDroppedFilePath(file));
  const resolvedPaths = paths.filter((path): path is string => typeof path === 'string' && path.length > 0);
  if (resolvedPaths.length === 0) {
    return undefined;
  }
  if (resolvedPaths.length !== files.length) {
    throw new Error('Electron external drop did not expose every dropped file path.');
  }
  return resolvedPaths;
}

interface BrowserFileSystemEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

interface BrowserFileSystemFileEntry extends BrowserFileSystemEntry {
  file(callback: (file: File) => void): void;
}

interface BrowserFileSystemDirectoryEntry extends BrowserFileSystemEntry {
  createReader(): {
    readEntries(callback: (entries: BrowserFileSystemEntry[]) => void): void;
  };
}

async function browserEntryUploadEntries(
  dataTransfer: DataTransfer,
  targetDirectoryProjectRelativePath: string
): Promise<ProjectTreeExternalUploadEntry[]> {
  const items = Array.from(dataTransfer.items).filter((item) => item.kind === 'file');
  const entries: BrowserFileSystemEntry[] = [];
  for (const item of items) {
    const entry = browserEntryFromDataTransferItem(item);
    if (entry) {
      entries.push(entry);
    }
  }
  if (entries.length > 0 && entries.length !== items.length) {
    throw new Error('Browser external drop did not expose every dropped file entry.');
  }

  const uploads: ProjectTreeExternalUploadEntry[] = [];
  for (const entry of entries) {
    uploads.push(...await uploadEntriesFromBrowserEntry(entry, targetDirectoryProjectRelativePath));
  }
  return uploads;
}

function browserEntryFromDataTransferItem(item: DataTransferItem): BrowserFileSystemEntry | null {
  return (item as DataTransferItem & {
    webkitGetAsEntry?: () => BrowserFileSystemEntry | null;
  }).webkitGetAsEntry?.() ?? null;
}

async function uploadEntriesFromBrowserEntry(
  entry: BrowserFileSystemEntry,
  parentProjectRelativePath: string
): Promise<ProjectTreeExternalUploadEntry[]> {
  if (entry.isFile) {
    const file = await fileFromBrowserEntry(entry as BrowserFileSystemFileEntry);
    return [{
      kind: 'file',
      file,
      projectRelativePath: joinExternalDropPath(parentProjectRelativePath, entry.name)
    }];
  }
  if (!entry.isDirectory) {
    return [];
  }
  const directoryPath = joinExternalDropPath(parentProjectRelativePath, entry.name);
  const entries = await entriesFromBrowserDirectoryEntry(entry as BrowserFileSystemDirectoryEntry);
  const uploads: ProjectTreeExternalUploadEntry[] = [{
    kind: 'directory',
    projectRelativePath: directoryPath
  }];
  for (const child of entries) {
    uploads.push(...await uploadEntriesFromBrowserEntry(child, directoryPath));
  }
  return uploads;
}

function fileFromBrowserEntry(entry: BrowserFileSystemFileEntry): Promise<File> {
  return new Promise((resolve) => entry.file(resolve));
}

function entriesFromBrowserDirectoryEntry(entry: BrowserFileSystemDirectoryEntry): Promise<BrowserFileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: BrowserFileSystemEntry[] = [];
  return new Promise((resolve) => {
    const readNextChunk = () => {
      reader.readEntries((chunk) => {
        if (chunk.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...chunk);
        readNextChunk();
      });
    };
    readNextChunk();
  });
}

function browserFileProjectRelativePath(file: File): string {
  const webkitRelativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return normalizeExternalDropPath(webkitRelativePath || file.name);
}

function joinExternalDropPath(parentPath: string, childPath: string): string {
  const parent = normalizeExternalDropPath(parentPath);
  const child = normalizeExternalDropPath(childPath);
  return parent ? `${parent}/${child}` : child;
}

function normalizeExternalDropPath(projectRelativePath: string): string {
  return projectRelativePath.split('/').filter(Boolean).join('/');
}
