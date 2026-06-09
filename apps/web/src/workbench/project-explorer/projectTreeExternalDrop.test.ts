import { describe, expect, it } from 'vitest';
import { createProjectTreeExternalDropPlan, hasProjectTreeExternalDrag } from './projectTreeExternalDrop';

describe('project tree external drop', () => {
  it('uses Electron local paths when the shell exposes dropped file paths', async () => {
    const file = new File(['cover'], 'cover.png');

    await expect(createProjectTreeExternalDropPlan({
      dataTransfer: dataTransferWithFiles([file]),
      shell: {
        chooseProjectRoot: async () => undefined,
        getDroppedFilePath: () => '/external/cover.png'
      },
      targetDirectoryProjectRelativePath: 'assets'
    })).resolves.toEqual({
      localPaths: ['/external/cover.png'],
      uploads: [],
      targetDirectoryProjectRelativePath: 'assets'
    });
  });

  it('detects browser external drags before files are exposed on dragover', () => {
    expect(hasProjectTreeExternalDrag({
      files: [],
      types: ['Files']
    } as unknown as DataTransfer)).toBe(true);
    expect(hasProjectTreeExternalDrag({
      files: [new File(['cover'], 'cover.png')],
      types: []
    } as unknown as DataTransfer)).toBe(true);
    expect(hasProjectTreeExternalDrag({
      files: [],
      types: ['text/plain']
    } as unknown as DataTransfer)).toBe(false);
  });

  it('creates browser upload entries when local paths are unavailable', async () => {
    const file = new File(['page'], 'page.png');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'pages/page.png' });

    await expect(createProjectTreeExternalDropPlan({
      dataTransfer: dataTransferWithFiles([file]),
      shell: undefined,
      targetDirectoryProjectRelativePath: 'assets'
    })).resolves.toMatchObject({
      localPaths: [],
      uploads: [{
        file,
        projectRelativePath: 'assets/pages/page.png'
      }],
      targetDirectoryProjectRelativePath: 'assets'
    });
  });

  it('walks browser directory entries when external folders are dropped', async () => {
    const file = new File(['page'], 'page.png');

    await expect(createProjectTreeExternalDropPlan({
      dataTransfer: {
        files: [],
        items: [{
          kind: 'file',
          webkitGetAsEntry: () => directoryEntry('pages', [
            fileEntry('page.png', file)
          ])
        }]
      } as unknown as DataTransfer,
      shell: undefined,
      targetDirectoryProjectRelativePath: 'assets'
    })).resolves.toMatchObject({
      localPaths: [],
      uploads: [
        {
          kind: 'directory',
          projectRelativePath: 'assets/pages'
        },
        {
          kind: 'file',
          file,
          projectRelativePath: 'assets/pages/page.png'
        }
      ],
      targetDirectoryProjectRelativePath: 'assets'
    });
  });

  it('keeps empty browser directories in the external import plan', async () => {
    await expect(createProjectTreeExternalDropPlan({
      dataTransfer: {
        files: [],
        items: [{
          kind: 'file',
          webkitGetAsEntry: () => directoryEntry('pages', [
            directoryEntry('empty', [])
          ])
        }]
      } as unknown as DataTransfer,
      shell: undefined,
      targetDirectoryProjectRelativePath: 'assets'
    })).resolves.toMatchObject({
      localPaths: [],
      uploads: [
        {
          kind: 'directory',
          projectRelativePath: 'assets/pages'
        },
        {
          kind: 'directory',
          projectRelativePath: 'assets/pages/empty'
        }
      ],
      targetDirectoryProjectRelativePath: 'assets'
    });
  });

  it('continues reading browser directory entries until the reader is exhausted', async () => {
    const firstFile = new File(['first'], 'first.png');
    const secondFile = new File(['second'], 'second.png');

    await expect(createProjectTreeExternalDropPlan({
      dataTransfer: {
        files: [],
        items: [{
          kind: 'file',
          webkitGetAsEntry: () => chunkedDirectoryEntry('pages', [
            [fileEntry('first.png', firstFile)],
            [fileEntry('second.png', secondFile)],
            []
          ])
        }]
      } as unknown as DataTransfer,
      shell: undefined,
      targetDirectoryProjectRelativePath: 'assets'
    })).resolves.toMatchObject({
      localPaths: [],
      uploads: [
        {
          kind: 'directory',
          projectRelativePath: 'assets/pages'
        },
        {
          kind: 'file',
          file: firstFile,
          projectRelativePath: 'assets/pages/first.png'
        },
        {
          kind: 'file',
          file: secondFile,
          projectRelativePath: 'assets/pages/second.png'
        }
      ],
      targetDirectoryProjectRelativePath: 'assets'
    });
  });
});

function dataTransferWithFiles(files: File[]): DataTransfer {
  return { files } as unknown as DataTransfer;
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
