import { describe, expect, it } from 'vitest';
import type { DebruteShellApi } from '@debrute/app-protocol';
import { createProjectExternalDropSource, hasProjectTreeExternalDrag } from './projectTreeExternalDrop';

describe('project tree external drop', () => {
  it('uses Electron local paths when the shell exposes dropped file paths', async () => {
    const file = new File(['cover'], 'cover.png');

    await expect(createProjectExternalDropSource({
      dataTransfer: dataTransferWithFiles([file]),
      shell: shellApiFixture({ getDroppedFilePath: () => '/external/cover.png' })
    })).resolves.toEqual({
      kind: 'local-paths',
      sourcePaths: ['/external/cover.png']
    });
  });

  it('rejects Electron external drops when only part of the batch exposes local paths', async () => {
    const cover = new File(['cover'], 'cover.png');
    const notes = new File(['notes'], 'notes.md');

    await expect(createProjectExternalDropSource({
      dataTransfer: dataTransferWithFiles([cover, notes]),
      shell: shellApiFixture({
        getDroppedFilePath: (file) => file.name === 'cover.png' ? '/external/cover.png' : undefined
      })
    })).rejects.toThrow('Electron external drop did not expose every dropped file path.');
  });

  it('detects browser external drags before files are exposed on dragover', () => {
    expect(hasProjectTreeExternalDrag({
      files: [],
      types: ['Files'],
      items: []
    } as unknown as DataTransfer)).toBe(true);
    expect(hasProjectTreeExternalDrag({
      files: [new File(['cover'], 'cover.png')],
      types: [],
      items: []
    } as unknown as DataTransfer)).toBe(true);
    expect(hasProjectTreeExternalDrag({
      files: [],
      types: ['text/plain'],
      items: []
    } as unknown as DataTransfer)).toBe(false);
  });

  it('creates browser upload entries when local paths are unavailable', async () => {
    const file = new File(['page'], 'page.png');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'pages/page.png' });

    await expect(createProjectExternalDropSource({
      dataTransfer: dataTransferWithFiles([file]),
      shell: undefined
    })).resolves.toMatchObject({
      kind: 'uploads',
      entries: [{
        file,
        relativePath: 'pages/page.png'
      }]
    });
  });

  it('walks browser directory entries when external folders are dropped', async () => {
    const file = new File(['page'], 'page.png');

    await expect(createProjectExternalDropSource({
      dataTransfer: {
        files: [],
        types: ['Files'],
        items: [{
          kind: 'file',
          webkitGetAsEntry: () => directoryEntry('pages', [
            fileEntry('page.png', file)
          ])
        }]
      } as unknown as DataTransfer,
      shell: undefined
    })).resolves.toMatchObject({
      kind: 'uploads',
      entries: [
        {
          kind: 'directory',
          relativePath: 'pages'
        },
        {
          kind: 'file',
          file,
          relativePath: 'pages/page.png'
        }
      ]
    });
  });

  it('rejects browser entry drops when only part of the batch exposes file entries', async () => {
    const cover = new File(['cover'], 'cover.png');

    await expect(createProjectExternalDropSource({
      dataTransfer: {
        files: [cover, new File(['notes'], 'notes.md')],
        types: ['Files'],
        items: [
          {
            kind: 'file',
            webkitGetAsEntry: () => fileEntry('cover.png', cover)
          },
          {
            kind: 'file',
            webkitGetAsEntry: () => null
          }
        ]
      } as unknown as DataTransfer,
      shell: undefined
    })).rejects.toThrow('Browser external drop did not expose every dropped file entry.');
  });

  it('keeps empty browser directories in the external import plan', async () => {
    await expect(createProjectExternalDropSource({
      dataTransfer: {
        files: [],
        types: ['Files'],
        items: [{
          kind: 'file',
          webkitGetAsEntry: () => directoryEntry('pages', [
            directoryEntry('empty', [])
          ])
        }]
      } as unknown as DataTransfer,
      shell: undefined
    })).resolves.toMatchObject({
      kind: 'uploads',
      entries: [
        {
          kind: 'directory',
          relativePath: 'pages'
        },
        {
          kind: 'directory',
          relativePath: 'pages/empty'
        }
      ]
    });
  });

  it('continues reading browser directory entries until the reader is exhausted', async () => {
    const firstFile = new File(['first'], 'first.png');
    const secondFile = new File(['second'], 'second.png');

    await expect(createProjectExternalDropSource({
      dataTransfer: {
        files: [],
        types: ['Files'],
        items: [{
          kind: 'file',
          webkitGetAsEntry: () => chunkedDirectoryEntry('pages', [
            [fileEntry('first.png', firstFile)],
            [fileEntry('second.png', secondFile)],
            []
          ])
        }]
      } as unknown as DataTransfer,
      shell: undefined
    })).resolves.toMatchObject({
      kind: 'uploads',
      entries: [
        {
          kind: 'directory',
          relativePath: 'pages'
        },
        {
          kind: 'file',
          file: firstFile,
          relativePath: 'pages/first.png'
        },
        {
          kind: 'file',
          file: secondFile,
          relativePath: 'pages/second.png'
        }
      ]
    });
  });
});

function dataTransferWithFiles(files: File[]): DataTransfer {
  return {
    files,
    types: files.length > 0 ? ['Files'] : [],
    items: files.map(() => ({ kind: 'file' }))
  } as unknown as DataTransfer;
}

function shellApiFixture(overrides: Partial<DebruteShellApi>): DebruteShellApi {
  return {
    getNativeWindowState: async () => ({ maximized: false }),
    minimizeNativeWindow: async () => ({ maximized: false }),
    toggleMaximizeNativeWindow: async () => ({ maximized: true }),
    closeNativeWindow: async () => ({ ok: true }),
    executeNativeMenuCommand: async () => ({ result: 'completed' }),
    takeDesktopLaunchContext: async () => undefined,
    onNativeWindowStateChanged: () => () => undefined,
    onNativeEditCommand: () => () => undefined,
    onNativeProjectOpenRequested: () => () => undefined,
    getDroppedFilePath: () => undefined,
    ...overrides
  };
}

function fileEntry(name: string, file: File) {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (callback: (file: File) => void) => callback(file)
  };
}

function directoryEntry(name: string, entries: unknown[]) {
  return chunkedDirectoryEntry(name, [entries]);
}

function chunkedDirectoryEntry(name: string, chunks: unknown[][]) {
  let index = 0;
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries: (callback: (entries: unknown[]) => void) => callback(chunks[index++] ?? [])
    })
  };
}
