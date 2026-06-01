import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  assertProjectTreeVisibleMutationPath,
  copyProjectPath,
  createProjectDirectory,
  createProjectFile,
  deleteProjectPathPermanently,
  getAxisProjectPaths,
  initializeBlankProject,
  listAxisProjectFiles,
  moveProjectPath,
  normalizeFileWatchEvent,
  nextCopyProjectPathName,
  projectFileRevision,
  renameProjectPath,
  resolveProjectPath,
  watchProjectFiles
} from '@axis/project-core';

describe('project-core', () => {
  it('initializes project metadata and canvases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-project-'));
    try {
      await initializeBlankProject(root, { name: 'AXIS Project' });
      const paths = getAxisProjectPaths(root);
      const projectFile = await stat(paths.projectFile);
      const canvasesDir = await stat(paths.canvasesDir);

      expect(projectFile.isFile()).toBe(true);
      expect(canvasesDir.isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('classifies project file watch events by current AXIS boundaries', () => {
    expect(normalizeFileWatchEvent('/project', '/project/.axis/canvases/main.json', 'changed').affects).toEqual(['canvas']);
    expect(normalizeFileWatchEvent('/project', '/project/.axis/project.json', 'changed').affects).toEqual(['project-metadata']);
    expect(normalizeFileWatchEvent('/project', '/project/.axis/assets/generated-assets-index.json', 'changed').affects).toEqual(['generated-asset-metadata']);
    expect(normalizeFileWatchEvent('/project', '/project/.axis/assets/generated/record-1.json', 'changed').affects).toEqual(['generated-asset-metadata']);
    expect(normalizeFileWatchEvent('/project', '/project/.axis/cache/file-fingerprints.json', 'changed').affects).toEqual(['generated-asset-metadata']);
    expect(normalizeFileWatchEvent('/project', '/project/.axis/cache/canvas-image-previews/preview.jpg', 'changed').affects).toEqual([]);
    expect(normalizeFileWatchEvent('/project', '/project/work/items.json', 'changed').affects).toEqual(['content']);
  });

  it('owns project file revision tokens in project-core', () => {
    expect(projectFileRevision(2048, 1001.2)).toBe('1001:2048');
  });

  it('keeps Canvas image preview cache files out of project-visible files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-project-preview-cache-'));
    try {
      await mkdir(join(root, '.axis/cache/canvas-image-previews'), { recursive: true });
      await mkdir(join(root, 'images'), { recursive: true });
      await writeFile(join(root, '.axis/cache/canvas-image-previews/preview.jpg'), 'cache', 'utf8');
      await writeFile(join(root, 'images/source.png'), 'source', 'utf8');

      const paths = (await listAxisProjectFiles(root)).map((file) => file.projectRelativePath);

      expect(paths).toContain('images/source.png');
      expect(paths).not.toContain('.axis/cache/canvas-image-previews');
      expect(paths).not.toContain('.axis/cache/canvas-image-previews/preview.jpg');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not recurse into Canvas image preview cache directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-project-preview-cache-skip-'));
    const unreadableCacheDir = join(root, '.axis/cache/canvas-image-previews/unreadable');
    try {
      await mkdir(unreadableCacheDir, { recursive: true });
      await mkdir(join(root, 'images'), { recursive: true });
      await writeFile(join(root, 'images/source.png'), 'source', 'utf8');
      await chmod(unreadableCacheDir, 0o000);

      const paths = (await listAxisProjectFiles(root)).map((file) => file.projectRelativePath);

      expect(paths).toContain('images/source.png');
      expect(paths.some((path) => path.startsWith('.axis/cache/canvas-image-previews'))).toBe(false);
    } finally {
      await chmod(unreadableCacheDir, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('emits debounced watcher events for project-visible files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-watch-'));
    try {
      const eventPromise = new Promise<string>((resolve) => {
        const handle = watchProjectFiles(root, (event) => {
          if (event.projectRelativePath === 'notes/brief.md') {
            handle.close();
            resolve(event.projectRelativePath);
          }
        }, { debounceMs: 5 });
      });
      await mkdir(join(root, 'notes'), { recursive: true });
      await writeFile(join(root, 'notes/brief.md'), 'hello\n', 'utf8');
      await expect(eventPromise).resolves.toBe('notes/brief.md');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates files and directories from safe basenames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-project-file-ops-create-'));
    try {
      const directory = await createProjectDirectory(root, { parentProjectRelativePath: '', name: 'briefs' });
      const file = await createProjectFile(root, { parentProjectRelativePath: 'briefs', name: 'concept.md' });

      expect(directory).toEqual({ projectRelativePath: 'briefs', kind: 'directory' });
      expect(file).toEqual({ projectRelativePath: 'briefs/concept.md', kind: 'file' });
      await expect(stat(join(root, 'briefs'))).resolves.toMatchObject({});
      await expect(readFile(join(root, 'briefs/concept.md'), 'utf8')).resolves.toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renames project files without overwriting siblings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-project-file-ops-rename-'));
    try {
      await mkdir(join(root, 'briefs'), { recursive: true });
      await writeFile(join(root, 'briefs/draft.md'), 'draft', 'utf8');
      await writeFile(join(root, 'briefs/final.md'), 'final', 'utf8');

      await expect(renameProjectPath(root, { projectRelativePath: 'briefs/draft.md', name: 'final.md' }))
        .rejects.toThrow('Project path already exists: briefs/final.md');

      const renamed = await renameProjectPath(root, { projectRelativePath: 'briefs/draft.md', name: 'outline.md' });

      expect(renamed).toEqual({ projectRelativePath: 'briefs/outline.md', kind: 'file' });
      await expect(readFile(join(root, 'briefs/outline.md'), 'utf8')).resolves.toBe('draft');
      expect(existsSync(join(root, 'briefs/draft.md'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('copies project paths with VSCode-style conflict names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-project-file-ops-copy-'));
    try {
      await mkdir(join(root, 'assets'), { recursive: true });
      await writeFile(join(root, 'assets/cover.png'), 'cover', 'utf8');
      await writeFile(join(root, 'assets/cover copy.png'), 'existing', 'utf8');

      const copied = await copyProjectPath(root, {
        sourceProjectRelativePath: 'assets/cover.png',
        targetDirectoryProjectRelativePath: 'assets'
      });

      expect(copied).toEqual({ projectRelativePath: 'assets/cover copy 2.png', kind: 'file' });
      await expect(readFile(join(root, 'assets/cover copy 2.png'), 'utf8')).resolves.toBe('cover');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('moves project paths and rejects moving a directory into itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-project-file-ops-move-'));
    try {
      await mkdir(join(root, 'assets/pages'), { recursive: true });
      await writeFile(join(root, 'assets/pages/page-1.png'), 'page', 'utf8');

      await expect(moveProjectPath(root, {
        sourceProjectRelativePath: 'assets',
        targetDirectoryProjectRelativePath: 'assets/pages'
      })).rejects.toThrow('Cannot move a directory into itself or one of its descendants.');

      const moved = await moveProjectPath(root, {
        sourceProjectRelativePath: 'assets/pages/page-1.png',
        targetDirectoryProjectRelativePath: ''
      });

      expect(moved).toEqual({ projectRelativePath: 'page-1.png', kind: 'file' });
      await expect(readFile(join(root, 'page-1.png'), 'utf8')).resolves.toBe('page');
      expect(existsSync(join(root, 'assets/pages/page-1.png'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps cut-paste into the current parent as a no-op move', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-project-file-ops-move-same-parent-'));
    try {
      await mkdir(join(root, 'assets'), { recursive: true });
      await writeFile(join(root, 'assets/cover.png'), 'cover', 'utf8');

      const moved = await moveProjectPath(root, {
        sourceProjectRelativePath: 'assets/cover.png',
        targetDirectoryProjectRelativePath: 'assets'
      });

      expect(moved).toEqual({ projectRelativePath: 'assets/cover.png', kind: 'file' });
      await expect(readFile(join(root, 'assets/cover.png'), 'utf8')).resolves.toBe('cover');
      expect(existsSync(join(root, 'assets/cover copy.png'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deletes project paths permanently inside the project root only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-project-file-ops-delete-'));
    try {
      await mkdir(join(root, 'assets/pages'), { recursive: true });
      await writeFile(join(root, 'assets/pages/page-1.png'), 'page', 'utf8');

      const deleted = await deleteProjectPathPermanently(root, { projectRelativePath: 'assets' });

      expect(deleted).toEqual({ projectRelativePath: 'assets', kind: 'directory' });
      expect(existsSync(join(root, 'assets'))).toBe(false);
      await expect(deleteProjectPathPermanently(root, { projectRelativePath: '../outside' }))
        .rejects.toThrow('Project path must not contain "." or ".." segments');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects mutations for project-internal cache paths hidden from the Project Tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-project-file-ops-hidden-cache-'));
    try {
      await mkdir(join(root, '.axis/cache/canvas-image-previews'), { recursive: true });
      await writeFile(join(root, '.axis/cache/canvas-image-previews/preview.jpg'), 'cache', 'utf8');

      await expect(createProjectFile(root, {
        parentProjectRelativePath: '.axis/cache/canvas-image-previews',
        name: 'created.jpg'
      })).rejects.toThrow('Project path is not visible in the Project Tree');
      await expect(copyProjectPath(root, {
        sourceProjectRelativePath: '.axis/cache/canvas-image-previews/preview.jpg',
        targetDirectoryProjectRelativePath: ''
      })).rejects.toThrow('Project path is not visible in the Project Tree');
      await expect(deleteProjectPathPermanently(root, {
        projectRelativePath: '.axis/cache/canvas-image-previews'
      })).rejects.toThrow('Project path is not visible in the Project Tree');
      await expect(readFile(join(root, '.axis/cache/canvas-image-previews/preview.jpg'), 'utf8')).resolves.toBe('cache');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exposes the Project Tree mutation visibility boundary for desktop actions', () => {
    expect(() => assertProjectTreeVisibleMutationPath('assets/cover.png')).not.toThrow();
    expect(() => assertProjectTreeVisibleMutationPath('.axis/cache/canvas-image-previews/preview.jpg'))
      .toThrow('Project path is not visible in the Project Tree');
    expect(() => assertProjectTreeVisibleMutationPath('.git/config'))
      .toThrow('Project path is not visible in the Project Tree');
  });

  it('generates repeated copy names for files and extensionless paths', () => {
    expect(nextCopyProjectPathName(new Set(['cover.png']), 'cover.png')).toBe('cover copy.png');
    expect(nextCopyProjectPathName(new Set(['cover.png', 'cover copy.png']), 'cover.png')).toBe('cover copy 2.png');
    expect(nextCopyProjectPathName(new Set(['brief', 'brief copy']), 'brief')).toBe('brief copy 2');
  });

  it('rejects unsafe basenames for create and rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-project-file-ops-unsafe-name-'));
    try {
      await mkdir(join(root, 'briefs'), { recursive: true });
      await writeFile(join(root, 'briefs/draft.md'), 'draft', 'utf8');

      await expect(createProjectFile(root, { parentProjectRelativePath: 'briefs', name: '../escape.md' }))
        .rejects.toThrow('Project path name must be a basename.');
      await expect(createProjectDirectory(root, { parentProjectRelativePath: 'briefs', name: '' }))
        .rejects.toThrow('Project path name must be non-empty.');
      await expect(renameProjectPath(root, { projectRelativePath: 'briefs/draft.md', name: 'nested/name.md' }))
        .rejects.toThrow('Project path name must be a basename.');
      await expect(createProjectFile(root, { parentProjectRelativePath: join(root, 'briefs'), name: 'absolute.md' }))
        .rejects.toThrow('Project path must be relative');
      await expect(deleteProjectPathPermanently(root, { projectRelativePath: join(root, 'briefs/draft.md') }))
        .rejects.toThrow('Project path must be relative');
      expect(() => resolveProjectPath(root, '../escape.md')).toThrow('Project path must not contain "." or ".." segments');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
