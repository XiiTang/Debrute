import type { DebruteShellApi } from '../../api/shellApi';

export type ProjectExternalDropSource =
  | { kind: 'local-paths'; sourcePaths: string[] }
  | {
      kind: 'uploads';
      entries: ProjectExternalDropUploadEntry[];
    };

export type ProjectExternalDropUploadEntry =
  | { kind: 'directory'; relativePath: string }
  | { kind: 'file'; relativePath: string; file: File };

export function hasProjectTreeExternalDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).includes('Files');
}

export async function createProjectExternalDropSource(input: {
  dataTransfer: DataTransfer;
  shell: DebruteShellApi | undefined;
}): Promise<ProjectExternalDropSource> {
  const files = Array.from(input.dataTransfer.files);
  const localPaths = electronLocalDropPaths(files, input.shell);
  if (localPaths) {
    return { kind: 'local-paths', sourcePaths: localPaths };
  }

  const entryUploads = await browserEntryUploadEntries(input.dataTransfer);
  if (entryUploads.length > 0) {
    return { kind: 'uploads', entries: entryUploads };
  }

  return {
    kind: 'uploads',
    entries: files.map((file) => ({
      kind: 'file',
      file,
      relativePath: browserFileRelativePath(file)
    }))
  };
}

function electronLocalDropPaths(
  files: File[],
  shell: DebruteShellApi | undefined
): string[] | undefined {
  if (!shell || files.length === 0) {
    return undefined;
  }
  const paths = files.map((file) => shell.getDroppedFilePath(file));
  const resolvedPaths = paths.filter(
    (path): path is string => typeof path === 'string' && path.length > 0
  );
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
  dataTransfer: DataTransfer
): Promise<ProjectExternalDropUploadEntry[]> {
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

  const uploads: ProjectExternalDropUploadEntry[] = [];
  for (const entry of entries) {
    uploads.push(...await uploadEntriesFromBrowserEntry(entry, ''));
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
  parentRelativePath: string
): Promise<ProjectExternalDropUploadEntry[]> {
  const relativePath = parentRelativePath ? `${parentRelativePath}/${entry.name}` : entry.name;
  if (entry.isFile) {
    return [{
      kind: 'file',
      file: await fileFromBrowserEntry(entry as BrowserFileSystemFileEntry),
      relativePath
    }];
  }
  if (!entry.isDirectory) {
    return [];
  }
  const uploads: ProjectExternalDropUploadEntry[] = [{ kind: 'directory', relativePath }];
  const children = await entriesFromBrowserDirectoryEntry(
    entry as BrowserFileSystemDirectoryEntry
  );
  for (const child of children) {
    uploads.push(...await uploadEntriesFromBrowserEntry(child, relativePath));
  }
  return uploads;
}

function fileFromBrowserEntry(entry: BrowserFileSystemFileEntry): Promise<File> {
  return new Promise((resolve) => entry.file(resolve));
}

function entriesFromBrowserDirectoryEntry(
  entry: BrowserFileSystemDirectoryEntry
): Promise<BrowserFileSystemEntry[]> {
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

function browserFileRelativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}
