import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  assertProjectTreeVisibleMutationPath,
  copyProjectPaths,
  createProjectDirectory,
  createProjectFile,
  deleteProjectPathsPermanently,
  getDebruteProjectPaths,
  importExternalLocalProjectPaths,
  importExternalUploadProjectEntries,
  initializeBlankProject,
  listDebruteProjectFiles,
  moveProjectPaths,
  readProjectFileBytes,
  readProjectTextFile,
  renameProjectPath,
  resolveNoSymlinkExistingProjectPath,
  resolveNoSymlinkProjectPathForWrite,
  resolveProjectPath,
  writeProjectTextFile,
  watchProjectFiles,
  type NormalizedFileWatchEvent
} from '@debrute/project-core';
import { consumeInternalProjectFileWatchEvent } from '../../../apps/app-server/src/project-session/projectWatchEvents';
import { DebruteAppServer } from '@debrute/app-server';

describe('app-server project files', () => {
  const IMAGE_PREVIEW_CACHE_PARENT = '.debrute/cache/canvas-image-previews/images%2Fsource.png--1234567890abcdef/1000%3A6';
  const IMAGE_PREVIEW_CACHE_PATH = `${IMAGE_PREVIEW_CACHE_PARENT}/preview-w300.jpg`;
  const TEXT_PREVIEW_CACHE_PARENT = '.debrute/cache/canvas-text-previews/canvas-1/notes%2Fa.md--1234567890abcdef';
  const TEXT_PREVIEW_CACHE_PATH = `${TEXT_PREVIEW_CACHE_PARENT}/preview-w700.png`;
  describe('project-core', () => {
    it('initializes project metadata and canvases', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-'));
      try {
        await initializeBlankProject(root, { name: 'Debrute Project' });
        const paths = getDebruteProjectPaths(root);
        const projectFile = await stat(paths.projectFile);
        const canvasesDir = await stat(paths.canvasesDir);
        expect(projectFile.isFile()).toBe(true);
        expect(canvasesDir.isDirectory()).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('reads supported project text files with registry language and MIME metadata', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-text-types-'));
      try {
        await mkdir(join(root, 'batch'), { recursive: true });
        await mkdir(join(root, 'scripts'), { recursive: true });
        await mkdir(join(root, 'logs'), { recursive: true });
        await mkdir(join(root, 'bin'), { recursive: true });
        await writeFile(join(root, 'batch/requests.jsonl'), '{"prompt":"one"}\n', 'utf8');
        await writeFile(join(root, 'scripts/run.sh'), '#!/usr/bin/env bash\necho run\n', 'utf8');
        await writeFile(join(root, 'logs/results.log'), 'ok\n', 'utf8');
        await writeFile(join(root, '.env.local'), 'API_BASE=http://127.0.0.1\n', 'utf8');
        await writeFile(join(root, '.gitignore'), 'node_modules\n', 'utf8');
        await writeFile(join(root, 'Dockerfile'), 'FROM node:24\n', 'utf8');
        await writeFile(join(root, 'Makefile'), 'all:\n\tpnpm check\n', 'utf8');
        await writeFile(join(root, 'bin/run'), '#!/usr/bin/env bash\necho extensionless\n', 'utf8');
        await writeFile(join(root, 'LICENSE'), 'Apache-2.0\n', 'utf8');
        await expect(readProjectTextFile(root, 'batch/requests.jsonl')).resolves.toMatchObject({
          language: 'jsonl',
          mimeType: 'application/jsonl'
        });
        await expect(readProjectTextFile(root, 'scripts/run.sh')).resolves.toMatchObject({
          language: 'shell',
          mimeType: 'text/x-shellscript'
        });
        await expect(readProjectTextFile(root, 'logs/results.log')).resolves.toMatchObject({
          language: 'log',
          mimeType: 'text/plain'
        });
        await expect(readProjectTextFile(root, '.env.local')).resolves.toMatchObject({
          language: 'dotenv',
          mimeType: 'text/plain'
        });
        await expect(readProjectTextFile(root, '.gitignore')).resolves.toMatchObject({
          language: 'plaintext',
          mimeType: 'text/plain'
        });
        await expect(readProjectTextFile(root, 'Dockerfile')).resolves.toMatchObject({
          language: 'dockerfile',
          mimeType: 'text/plain'
        });
        await expect(readProjectTextFile(root, 'Makefile')).resolves.toMatchObject({
          language: 'makefile',
          mimeType: 'text/plain'
        });
        await expect(readProjectTextFile(root, 'bin/run')).resolves.toMatchObject({
          language: 'shell',
          mimeType: 'text/x-shellscript'
        });
        await expect(readProjectTextFile(root, 'LICENSE')).resolves.toMatchObject({
          language: 'plaintext',
          mimeType: 'text/plain'
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('keeps text-read safety checks strict while adding text formats', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-text-format-safety-'));
      try {
        await writeFile(join(root, 'binary.log'), Buffer.from([0x00, 0x01, 0x02]));
        await writeFile(join(root, 'invalid.jsonl'), Buffer.from([0x7b, 0x80, 0x7d]));
        await writeFile(join(root, 'oversized.sh'), '#!/usr/bin/env bash\necho too-large\n', 'utf8');
        await expect(readProjectTextFile(root, 'binary.log'))
          .rejects.toThrow('Project file appears to be binary, not text: binary.log');
        await expect(readProjectTextFile(root, 'invalid.jsonl'))
          .rejects.toThrow('Project file is not valid UTF-8 text: invalid.jsonl');
        await expect(readProjectTextFile(root, 'oversized.sh', { maxBytes: 8 }))
          .rejects.toThrow('Project file is too large to open as text');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('keeps Canvas image preview cache files out of project-visible files', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-preview-cache-'));
      try {
        await mkdir(join(root, IMAGE_PREVIEW_CACHE_PARENT), { recursive: true });
        await mkdir(join(root, 'images'), { recursive: true });
        await writeFile(join(root, IMAGE_PREVIEW_CACHE_PATH), 'cache', 'utf8');
        await writeFile(join(root, 'images/source.png'), 'source', 'utf8');
        const paths = (await listDebruteProjectFiles(root)).map((file) => file.projectRelativePath);
        expect(paths).toContain('images/source.png');
        expect(paths).not.toContain('.debrute/cache/canvas-image-previews');
        expect(paths).not.toContain(IMAGE_PREVIEW_CACHE_PATH);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('keeps Canvas text preview cache files out of project-visible files', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-text-preview-cache-'));
      try {
        await mkdir(join(root, TEXT_PREVIEW_CACHE_PARENT), { recursive: true });
        await mkdir(join(root, 'notes'), { recursive: true });
        await writeFile(join(root, TEXT_PREVIEW_CACHE_PATH), 'cache', 'utf8');
        await writeFile(join(root, 'notes/a.md'), 'source', 'utf8');
        const paths = (await listDebruteProjectFiles(root)).map((file) => file.projectRelativePath);
        expect(paths).toContain('notes/a.md');
        expect(paths.some((path) => path.startsWith('.debrute/cache/canvas-text-previews'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('keeps ProjectDocument lock files out of project-visible files', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-document-locks-'));
      try {
        await mkdir(join(root, '.debrute/canvases'), { recursive: true });
        await mkdir(join(root, 'notes'), { recursive: true });
        await writeFile(join(root, '.debrute/canvases/canvas-1.json.lock'), '', 'utf8');
        await writeFile(join(root, 'notes/brief.md'), 'brief', 'utf8');
        const paths = (await listDebruteProjectFiles(root)).map((file) => file.projectRelativePath);
        expect(paths).toContain('notes/brief.md');
        expect(paths).not.toContain('.debrute/canvases/canvas-1.json.lock');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('does not recurse into Canvas image preview cache directories', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-preview-cache-skip-'));
      const unreadableCacheDir = join(root, '.debrute/cache/canvas-image-previews/unreadable');
      try {
        await mkdir(unreadableCacheDir, { recursive: true });
        await mkdir(join(root, 'images'), { recursive: true });
        await writeFile(join(root, 'images/source.png'), 'source', 'utf8');
        const paths = (await listDebruteProjectFiles(root)).map((file) => file.projectRelativePath);
        expect(paths).toContain('images/source.png');
        expect(paths.some((path) => path.startsWith('.debrute/cache/canvas-image-previews'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('emits debounced watcher events for project-visible files', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-watch-'));
      let handle: ReturnType<typeof watchProjectFiles> | undefined;
      try {
        await mkdir(join(root, 'notes'), { recursive: true });
        let probeObservedAt: number | undefined;
        let resolveTarget!: (projectRelativePath: string) => void;
        const targetEvent = new Promise<string>((resolve) => {
          resolveTarget = resolve;
        });
        handle = watchProjectFiles(root, (event) => {
          if (event.projectRelativePath === 'notes/watch-probe.txt') {
            probeObservedAt = event.observedAt ?? Date.now();
          }
          if (event.projectRelativePath === 'notes/brief.md') {
            resolveTarget(event.projectRelativePath);
          }
        }, { debounceMs: 5 });
        await waitForProjectWatcherReadiness(
          join(root, 'notes/watch-probe.txt'),
          () => probeObservedAt
        );
        await writeFile(join(root, 'notes/brief.md'), 'hello\n', 'utf8');
        await expect(targetEvent).resolves.toBe('notes/brief.md');
      } finally {
        handle?.close();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('emits watcher events for user-authored tmp files', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-watch-user-tmp-'));
      let handle: ReturnType<typeof watchProjectFiles> | undefined;
      try {
        await mkdir(join(root, 'notes'), { recursive: true });
        let probeObservedAt: number | undefined;
        let resolveTarget!: (projectRelativePath: string) => void;
        const targetEvent = new Promise<string>((resolve) => {
          resolveTarget = resolve;
        });
        handle = watchProjectFiles(root, (event) => {
          if (event.projectRelativePath === 'notes/watch-probe.txt') {
            probeObservedAt = event.observedAt ?? Date.now();
          }
          if (event.projectRelativePath === 'notes/draft.tmp') {
            resolveTarget(event.projectRelativePath);
          }
        }, { debounceMs: 5 });
        await waitForProjectWatcherReadiness(
          join(root, 'notes/watch-probe.txt'),
          () => probeObservedAt
        );
        await writeFile(join(root, 'notes/draft.tmp'), 'visible\n', 'utf8');
        await expect(Promise.race([
          targetEvent,
          waitForProjectWatcherPoll(100).then(() => 'timeout')
        ])).resolves.toBe('notes/draft.tmp');
      } finally {
        handle?.close();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('creates files and directories from safe basenames', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-create-'));
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
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-rename-'));
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
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-copy-'));
      try {
        await mkdir(join(root, 'assets'), { recursive: true });
        await writeFile(join(root, 'assets/cover.png'), 'cover', 'utf8');
        await writeFile(join(root, 'assets/cover copy.png'), 'existing', 'utf8');
        const copied = await copyProjectPaths(root, {
          entries: [{ projectRelativePath: 'assets/cover.png', kind: 'file' }],
          targetDirectoryProjectRelativePath: 'assets'
        });
        expect(copied.results).toEqual([
          { sourceProjectRelativePath: 'assets/cover.png', projectRelativePath: 'assets/cover copy 2.png', kind: 'file', status: 'ok' }
        ]);
        await expect(readFile(join(root, 'assets/cover copy 2.png'), 'utf8')).resolves.toBe('cover');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('moves project paths and rejects moving a directory into itself', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-move-'));
      try {
        await mkdir(join(root, 'assets/pages'), { recursive: true });
        await writeFile(join(root, 'assets/pages/page-1.png'), 'page', 'utf8');
        await expect(moveProjectPaths(root, {
          entries: [{ projectRelativePath: 'assets', kind: 'directory' }],
          targetDirectoryProjectRelativePath: 'assets/pages'
        })).rejects.toThrow('Cannot move a directory into itself or one of its descendants.');
        const moved = await moveProjectPaths(root, {
          entries: [{ projectRelativePath: 'assets/pages/page-1.png', kind: 'file' }],
          targetDirectoryProjectRelativePath: ''
        });
        expect(moved.results).toEqual([
          { sourceProjectRelativePath: 'assets/pages/page-1.png', projectRelativePath: 'page-1.png', kind: 'file', status: 'ok' }
        ]);
        await expect(readFile(join(root, 'page-1.png'), 'utf8')).resolves.toBe('page');
        expect(existsSync(join(root, 'assets/pages/page-1.png'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('keeps cut-paste into the current parent as a no-op move', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-move-same-parent-'));
      try {
        await mkdir(join(root, 'assets'), { recursive: true });
        await writeFile(join(root, 'assets/cover.png'), 'cover', 'utf8');
        const moved = await moveProjectPaths(root, {
          entries: [{ projectRelativePath: 'assets/cover.png', kind: 'file' }],
          targetDirectoryProjectRelativePath: 'assets'
        });
        expect(moved.results).toEqual([
          { sourceProjectRelativePath: 'assets/cover.png', projectRelativePath: 'assets/cover.png', kind: 'file', status: 'skipped' }
        ]);
        await expect(readFile(join(root, 'assets/cover.png'), 'utf8')).resolves.toBe('cover');
        expect(existsSync(join(root, 'assets/cover copy.png'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('copies project path batches with unique names in order', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-copy-batch-'));
      try {
        await mkdir(join(root, 'assets'), { recursive: true });
        await writeFile(join(root, 'cover.png'), 'cover', 'utf8');
        await writeFile(join(root, 'assets/cover.png'), 'existing', 'utf8');
        await writeFile(join(root, 'brief.md'), 'brief', 'utf8');
        const copied = await copyProjectPaths(root, {
          entries: [
            { projectRelativePath: 'cover.png', kind: 'file' },
            { projectRelativePath: 'brief.md', kind: 'file' }
          ],
          targetDirectoryProjectRelativePath: 'assets'
        });
        expect(copied.results).toEqual([
          { sourceProjectRelativePath: 'cover.png', projectRelativePath: 'assets/cover copy.png', kind: 'file', status: 'ok' },
          { sourceProjectRelativePath: 'brief.md', projectRelativePath: 'assets/brief.md', kind: 'file', status: 'ok' }
        ]);
        await expect(readFile(join(root, 'assets/cover copy.png'), 'utf8')).resolves.toBe('cover');
        await expect(readFile(join(root, 'assets/brief.md'), 'utf8')).resolves.toBe('brief');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('copies only top-level selected project paths', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-copy-top-level-'));
      try {
        await mkdir(join(root, 'assets'), { recursive: true });
        await writeFile(join(root, 'assets/cover.png'), 'cover', 'utf8');
        const copied = await copyProjectPaths(root, {
          entries: [
            { projectRelativePath: 'assets', kind: 'directory' },
            { projectRelativePath: 'assets/cover.png', kind: 'file' }
          ],
          targetDirectoryProjectRelativePath: ''
        });
        expect(copied.results).toEqual([
          { sourceProjectRelativePath: 'assets', projectRelativePath: 'assets copy', kind: 'directory', status: 'ok' }
        ]);
        await expect(readFile(join(root, 'assets copy/cover.png'), 'utf8')).resolves.toBe('cover');
        expect(existsSync(join(root, 'cover.png'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects copying a directory into itself or one of its descendants before mutating the project', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-copy-descendant-'));
      try {
        await mkdir(join(root, 'assets/pages'), { recursive: true });
        await writeFile(join(root, 'assets/pages/page.txt'), 'page', 'utf8');
        await expect(copyProjectPaths(root, {
          entries: [{ projectRelativePath: 'assets', kind: 'directory' }],
          targetDirectoryProjectRelativePath: 'assets/pages'
        })).rejects.toThrow('Cannot copy a directory into itself or one of its descendants.');
        await expect(readFile(join(root, 'assets/pages/page.txt'), 'utf8')).resolves.toBe('page');
        expect(existsSync(join(root, 'assets/pages/assets'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('moves project path batches with overwrite support', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-move-batch-'));
      try {
        await mkdir(join(root, 'assets'), { recursive: true });
        await writeFile(join(root, 'cover.png'), 'new cover', 'utf8');
        await writeFile(join(root, 'assets/cover.png'), 'old cover', 'utf8');
        await writeFile(join(root, 'assets/skip.md'), 'skip', 'utf8');
        await expect(moveProjectPaths(root, {
          entries: [{ projectRelativePath: 'cover.png', kind: 'file' }],
          targetDirectoryProjectRelativePath: 'assets'
        })).rejects.toThrow('Project path already exists: assets/cover.png');
        const moved = await moveProjectPaths(root, {
          entries: [
            { projectRelativePath: 'cover.png', kind: 'file' },
            { projectRelativePath: 'assets/skip.md', kind: 'file' }
          ],
          targetDirectoryProjectRelativePath: 'assets',
          overwrite: true
        });
        expect(moved.results).toEqual([
          { sourceProjectRelativePath: 'cover.png', projectRelativePath: 'assets/cover.png', kind: 'file', status: 'ok' },
          { sourceProjectRelativePath: 'assets/skip.md', projectRelativePath: 'assets/skip.md', kind: 'file', status: 'skipped' }
        ]);
        await expect(readFile(join(root, 'assets/cover.png'), 'utf8')).resolves.toBe('new cover');
        expect(existsSync(join(root, 'cover.png'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects duplicate batch move targets before modifying sources or targets', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-move-duplicate-targets-'));
      try {
        await mkdir(join(root, 'a'), { recursive: true });
        await mkdir(join(root, 'b'), { recursive: true });
        await mkdir(join(root, 'target'), { recursive: true });
        await writeFile(join(root, 'a/item.txt'), 'from-a', 'utf8');
        await writeFile(join(root, 'b/item.txt'), 'from-b', 'utf8');
        await writeFile(join(root, 'target/item.txt'), 'existing', 'utf8');
        await expect(moveProjectPaths(root, {
          entries: [
            { projectRelativePath: 'a/item.txt', kind: 'file' },
            { projectRelativePath: 'b/item.txt', kind: 'file' }
          ],
          targetDirectoryProjectRelativePath: 'target',
          overwrite: true
        })).rejects.toThrow('Duplicate project path target in batch: target/item.txt');
        await expect(readFile(join(root, 'a/item.txt'), 'utf8')).resolves.toBe('from-a');
        await expect(readFile(join(root, 'b/item.txt'), 'utf8')).resolves.toBe('from-b');
        await expect(readFile(join(root, 'target/item.txt'), 'utf8')).resolves.toBe('existing');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('deletes project path batches permanently', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-delete-batch-'));
      try {
        await mkdir(join(root, 'assets/pages'), { recursive: true });
        await writeFile(join(root, 'assets/pages/page-1.png'), 'page', 'utf8');
        await writeFile(join(root, 'brief.md'), 'brief', 'utf8');
        const deleted = await deleteProjectPathsPermanently(root, {
          entries: [
            { projectRelativePath: 'assets', kind: 'directory' },
            { projectRelativePath: 'assets/pages/page-1.png', kind: 'file' },
            { projectRelativePath: 'brief.md', kind: 'file' }
          ]
        });
        expect(deleted.results).toEqual([
          { sourceProjectRelativePath: 'assets', projectRelativePath: 'assets', kind: 'directory', status: 'ok' },
          { sourceProjectRelativePath: 'brief.md', projectRelativePath: 'brief.md', kind: 'file', status: 'ok' }
        ]);
        expect(existsSync(join(root, 'assets'))).toBe(false);
        expect(existsSync(join(root, 'brief.md'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('imports external local paths by copying them into the target directory', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-import-local-'));
      const externalRoot = await mkdtemp(join(tmpdir(), 'debrute-project-external-'));
      try {
        await mkdir(join(root, 'assets'), { recursive: true });
        await writeFile(join(root, 'assets/cover.png'), 'old', 'utf8');
        await writeFile(join(externalRoot, 'cover.png'), 'new', 'utf8');
        await expect(importExternalLocalProjectPaths(root, {
          sources: [join(externalRoot, 'cover.png')],
          targetDirectoryProjectRelativePath: 'assets'
        })).rejects.toThrow('Project path already exists: assets/cover.png');
        const imported = await importExternalLocalProjectPaths(root, {
          sources: [join(externalRoot, 'cover.png')],
          targetDirectoryProjectRelativePath: 'assets',
          overwrite: true
        });
        expect(imported.results).toEqual([
          { sourceProjectRelativePath: join(externalRoot, 'cover.png'), projectRelativePath: 'assets/cover.png', kind: 'file', status: 'ok' }
        ]);
        await expect(readFile(join(root, 'assets/cover.png'), 'utf8')).resolves.toBe('new');
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(externalRoot, { recursive: true, force: true });
      }
    });

    it('rejects project-internal local imports that resolve to the import target before deleting files', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-import-local-self-'));
      try {
        await mkdir(join(root, 'assets'), { recursive: true });
        await writeFile(join(root, 'assets/cover.png'), 'original', 'utf8');
        await expect(importExternalLocalProjectPaths(root, {
          sources: [join(root, 'assets/cover.png')],
          targetDirectoryProjectRelativePath: 'assets',
          overwrite: true
        })).rejects.toThrow('External source path resolves to its project import target');
        await expect(readFile(join(root, 'assets/cover.png'), 'utf8')).resolves.toBe('original');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects project-internal directory imports into their own descendants', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-import-local-descendant-'));
      try {
        await mkdir(join(root, 'assets/pages'), { recursive: true });
        await writeFile(join(root, 'assets/pages/page.png'), 'page', 'utf8');
        await expect(importExternalLocalProjectPaths(root, {
          sources: [join(root, 'assets')],
          targetDirectoryProjectRelativePath: 'assets',
          overwrite: true
        })).rejects.toThrow('Cannot import a project directory into itself or one of its descendants.');
        await expect(readFile(join(root, 'assets/pages/page.png'), 'utf8')).resolves.toBe('page');
        expect(existsSync(join(root, 'assets/assets'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects symbolic link local imports before mutating the project', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-import-local-symlink-'));
      const externalRoot = await mkdtemp(join(tmpdir(), 'debrute-project-external-symlink-'));
      try {
        await mkdir(join(root, 'assets'), { recursive: true });
        const realDirectory = join(externalRoot, 'real');
        await mkdir(realDirectory);
        await writeFile(join(realDirectory, 'real.txt'), 'real', 'utf8');
        await symlink(realDirectory, join(externalRoot, 'link.txt'), directoryLinkType());
        await expect(importExternalLocalProjectPaths(root, {
          sources: [join(externalRoot, 'link.txt')],
          targetDirectoryProjectRelativePath: 'assets'
        })).rejects.toThrow('External source path must not be a symbolic link');
        expect(existsSync(join(root, 'assets/link.txt'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(externalRoot, { recursive: true, force: true });
      }
    });

    it('rejects duplicate external import targets before modifying the project', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-import-duplicate-targets-'));
      const firstExternalRoot = await mkdtemp(join(tmpdir(), 'debrute-project-external-a-'));
      const secondExternalRoot = await mkdtemp(join(tmpdir(), 'debrute-project-external-b-'));
      try {
        await mkdir(join(root, 'assets'), { recursive: true });
        await writeFile(join(root, 'assets/item.txt'), 'existing', 'utf8');
        await writeFile(join(firstExternalRoot, 'item.txt'), 'from-a', 'utf8');
        await writeFile(join(secondExternalRoot, 'item.txt'), 'from-b', 'utf8');
        await expect(importExternalLocalProjectPaths(root, {
          sources: [join(firstExternalRoot, 'item.txt'), join(secondExternalRoot, 'item.txt')],
          targetDirectoryProjectRelativePath: 'assets',
          overwrite: true
        })).rejects.toThrow('Duplicate project path target in batch: assets/item.txt');
        await expect(readFile(join(root, 'assets/item.txt'), 'utf8')).resolves.toBe('existing');
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(firstExternalRoot, { recursive: true, force: true });
        await rm(secondExternalRoot, { recursive: true, force: true });
      }
    });

    it('imports browser upload entries as one batch with directories and file bytes', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-upload-batch-'));
      try {
        await mkdir(join(root, 'assets'), { recursive: true });
        await writeFile(join(root, 'assets/pages'), 'old-file-conflict', 'utf8');
        await expect(importExternalUploadProjectEntries(root, {
          targetDirectoryProjectRelativePath: 'assets',
          entries: [
            { kind: 'directory', projectRelativePath: 'assets/pages' },
            { kind: 'directory', projectRelativePath: 'assets/pages/empty' },
            { kind: 'file', projectRelativePath: 'assets/pages/page.png', content: Buffer.from('new') }
          ]
        })).rejects.toThrow('Project path already exists: assets/pages');
        const imported = await importExternalUploadProjectEntries(root, {
          targetDirectoryProjectRelativePath: 'assets',
          entries: [
            { kind: 'directory', projectRelativePath: 'assets/pages' },
            { kind: 'directory', projectRelativePath: 'assets/pages/empty' },
            { kind: 'file', projectRelativePath: 'assets/pages/page.png', content: Buffer.from('new') }
          ],
          overwrite: true
        });
        expect(imported.results).toEqual([
          { sourceProjectRelativePath: 'assets/pages', projectRelativePath: 'assets/pages', kind: 'directory', status: 'ok' },
          { sourceProjectRelativePath: 'assets/pages/empty', projectRelativePath: 'assets/pages/empty', kind: 'directory', status: 'ok' },
          { sourceProjectRelativePath: 'assets/pages/page.png', projectRelativePath: 'assets/pages/page.png', kind: 'file', status: 'ok' }
        ]);
        await expect(stat(join(root, 'assets/pages/empty'))).resolves.toMatchObject({});
        await expect(readFile(join(root, 'assets/pages/page.png'), 'utf8')).resolves.toBe('new');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects duplicate browser upload targets before modifying the project', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-upload-duplicates-'));
      try {
        await mkdir(join(root, 'assets'), { recursive: true });
        await writeFile(join(root, 'assets/existing.txt'), 'existing', 'utf8');
        await expect(importExternalUploadProjectEntries(root, {
          targetDirectoryProjectRelativePath: 'assets',
          entries: [
            { kind: 'file', projectRelativePath: 'assets/item.txt', content: Buffer.from('first') },
            { kind: 'file', projectRelativePath: 'assets/item.txt', content: Buffer.from('second') }
          ],
          overwrite: true
        })).rejects.toThrow('Duplicate project path target in batch: assets/item.txt');
        await expect(readFile(join(root, 'assets/existing.txt'), 'utf8')).resolves.toBe('existing');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('deletes project paths permanently inside the project root only', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-delete-'));
      try {
        await mkdir(join(root, 'assets/pages'), { recursive: true });
        await writeFile(join(root, 'assets/pages/page-1.png'), 'page', 'utf8');
        const deleted = await deleteProjectPathsPermanently(root, {
          entries: [{ projectRelativePath: 'assets', kind: 'directory' }]
        });
        expect(deleted.results).toEqual([
          { sourceProjectRelativePath: 'assets', projectRelativePath: 'assets', kind: 'directory', status: 'ok' }
        ]);
        expect(existsSync(join(root, 'assets'))).toBe(false);
        await expect(deleteProjectPathsPermanently(root, {
          entries: [{ projectRelativePath: '../outside', kind: 'file' }]
        }))
          .rejects.toThrow('Project path must not contain "." or ".." segments');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects no-symlink existing targets when the final file is a symbolic link', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-no-symlink-existing-'));
      const externalRoot = await mkdtemp(join(tmpdir(), 'debrute-project-no-symlink-external-'));
      try {
        await mkdir(join(root, IMAGE_PREVIEW_CACHE_PARENT), { recursive: true });
        await writeFile(join(externalRoot, 'preview.jpg'), 'external', 'utf8');
        await symlink(externalRoot, join(root, IMAGE_PREVIEW_CACHE_PATH), directoryLinkType());
        await expect(resolveNoSymlinkExistingProjectPath(root, IMAGE_PREVIEW_CACHE_PATH))
          .rejects.toThrow('Project path must not be a symbolic link');
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(externalRoot, { recursive: true, force: true });
      }
    });

    it('rejects no-symlink write targets when the nearest existing parent escapes the project', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-no-symlink-write-'));
      const externalRoot = await mkdtemp(join(tmpdir(), 'debrute-project-no-symlink-write-external-'));
      try {
        await mkdir(join(root, '.debrute'), { recursive: true });
        await symlink(externalRoot, join(root, '.debrute/canvases'), directoryLinkType());
        await expect(resolveNoSymlinkProjectPathForWrite(root, '.debrute/canvases/canvas-1.json'))
          .rejects.toThrow('Project path escapes project root through a symlink');
        await expect(lstat(join(externalRoot, 'canvas-1.json'))).rejects.toBeDefined();
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(externalRoot, { recursive: true, force: true });
      }
    });

    it('rejects project tree deletes whose resolved target escapes the project', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-delete-symlink-'));
      const externalRoot = await mkdtemp(join(tmpdir(), 'debrute-project-delete-symlink-external-'));
      try {
        await mkdir(join(root, 'assets'), { recursive: true });
        await writeFile(join(externalRoot, 'outside.txt'), 'outside', 'utf8');
        await symlink(externalRoot, join(root, 'assets/link.txt'), directoryLinkType());
        await expect(deleteProjectPathsPermanently(root, {
          entries: [{ projectRelativePath: 'assets/link.txt', kind: 'file' }]
        })).rejects.toThrow('Project path escapes project root through a symlink');
        await expect(readFile(join(externalRoot, 'outside.txt'), 'utf8')).resolves.toBe('outside');
        expect(existsSync(join(root, 'assets/link.txt'))).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(externalRoot, { recursive: true, force: true });
      }
    });

    it('rejects mutations for project-internal cache paths hidden from the Project Tree', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-hidden-cache-'));
      try {
        await mkdir(join(root, IMAGE_PREVIEW_CACHE_PARENT), { recursive: true });
        await writeFile(join(root, IMAGE_PREVIEW_CACHE_PATH), 'cache', 'utf8');
        await expect(createProjectFile(root, {
          parentProjectRelativePath: IMAGE_PREVIEW_CACHE_PARENT,
          name: 'created.jpg'
        })).rejects.toThrow('Project path is not visible in the Project Tree');
        await expect(copyProjectPaths(root, {
          entries: [{ projectRelativePath: IMAGE_PREVIEW_CACHE_PATH, kind: 'file' }],
          targetDirectoryProjectRelativePath: ''
        })).rejects.toThrow('Project path is not visible in the Project Tree');
        await expect(deleteProjectPathsPermanently(root, {
          entries: [{ projectRelativePath: '.debrute/cache/canvas-image-previews', kind: 'directory' }]
        })).rejects.toThrow('Project path is not visible in the Project Tree');
        await expect(readFile(join(root, IMAGE_PREVIEW_CACHE_PATH), 'utf8')).resolves.toBe('cache');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects mutations for Canvas text preview cache paths hidden from the Project Tree', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-hidden-text-cache-'));
      try {
        await mkdir(join(root, TEXT_PREVIEW_CACHE_PARENT), { recursive: true });
        await writeFile(join(root, TEXT_PREVIEW_CACHE_PATH), 'cache', 'utf8');
        await expect(createProjectFile(root, {
          parentProjectRelativePath: TEXT_PREVIEW_CACHE_PARENT,
          name: 'created.png'
        })).rejects.toThrow('Project path is not visible in the Project Tree');
        await expect(copyProjectPaths(root, {
          entries: [{ projectRelativePath: TEXT_PREVIEW_CACHE_PATH, kind: 'file' }],
          targetDirectoryProjectRelativePath: ''
        })).rejects.toThrow('Project path is not visible in the Project Tree');
        await expect(deleteProjectPathsPermanently(root, {
          entries: [{ projectRelativePath: '.debrute/cache/canvas-text-previews', kind: 'directory' }]
        })).rejects.toThrow('Project path is not visible in the Project Tree');
        await expect(readFile(join(root, TEXT_PREVIEW_CACHE_PATH), 'utf8')).resolves.toBe('cache');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects direct text writes to hidden Project Tree paths', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-direct-hidden-write-'));
      try {
        await mkdir(join(root, '.git'), { recursive: true });
        await expect(writeProjectTextFile(root, {
          projectRelativePath: '.git/config',
          content: '[core]\n',
          expectedRevision: 'missing'
        }))
          .rejects.toThrow('Project path is not visible in the Project Tree');
        await expect(writeProjectTextFile(root, {
          projectRelativePath: '.GIT/config',
          content: '[core]\n',
          expectedRevision: 'missing'
        }))
          .rejects.toThrow('Project path is not visible in the Project Tree');
        expect(existsSync(join(root, '.git/config'))).toBe(false);
        expect(existsSync(join(root, '.GIT/config'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('allows revisioned text saves for structured Project Documents while keeping generic mutations protected', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-structured-doc-mutation-'));
      try {
        await mkdir(join(root, '.debrute/canvases'), { recursive: true });
        await mkdir(join(root, '.debrute/canvas-maps'), { recursive: true });
        await writeFile(join(root, '.debrute/canvases/canvas-1.json'), '{}\n', 'utf8');
        await writeFile(join(root, '.debrute/canvas-maps/canvas-1.yaml'), 'paths: []\n', 'utf8');
        expect((await listDebruteProjectFiles(root)).map((file) => file.projectRelativePath))
          .toContain('.debrute/canvas-maps/canvas-1.yaml');
        expect(() => assertProjectTreeVisibleMutationPath('.debrute/canvases/canvas-1.json'))
          .toThrow('Project path is protected by the Project Document System');
        expect(() => assertProjectTreeVisibleMutationPath('.debrute/canvas-maps/canvas-1.yaml'))
          .toThrow('Project path is protected by the Project Document System');
        expect(() => assertProjectTreeVisibleMutationPath('.DeBrute/canvases/canvas-1.json'))
          .toThrow('Project path is protected by the Project Document System');
        const opened = await readProjectTextFile(root, '.debrute/canvases/canvas-1.json');
        const saved = await writeProjectTextFile(root, {
          projectRelativePath: '.debrute/canvases/canvas-1.json',
          content: '{"changed":true}\n',
          expectedRevision: opened.revision
        });
        expect(saved.content).toBe('{"changed":true}\n');
        await expect(deleteProjectPathsPermanently(root, {
          entries: [{ projectRelativePath: '.debrute/canvases/canvas-1.json', kind: 'file' }]
        })).rejects.toThrow('Project path is protected by the Project Document System');
        await expect(readFile(join(root, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toBe('{"changed":true}\n');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects browser upload entries targeting mixed-case project-internal paths', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-upload-internal-case-'));
      try {
        await expect(importExternalUploadProjectEntries(root, {
          targetDirectoryProjectRelativePath: '',
          entries: [
            { kind: 'file', projectRelativePath: '.DeBrute/canvases/index.json', content: Buffer.from('{}\n') }
          ]
        })).rejects.toThrow('Project path is protected by the Project Document System');
        expect(existsSync(join(root, '.DeBrute/canvases/index.json'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects unsafe basenames for create and rename', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-file-ops-unsafe-name-'));
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
        await expect(deleteProjectPathsPermanently(root, {
          entries: [{ projectRelativePath: join(root, 'briefs/draft.md'), kind: 'file' }]
        }))
          .rejects.toThrow('Project path must be relative');
        expect(() => resolveProjectPath(root, '../escape.md')).toThrow('Project path must not contain "." or ".." segments');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects text file access through symlinks that escape the project root', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-symlink-boundary-'));
      const outside = await mkdtemp(join(tmpdir(), 'debrute-project-outside-'));
      try {
        await writeFile(join(outside, 'linked.txt'), 'outside', 'utf8');
        await symlink(outside, join(root, 'linked.txt'), directoryLinkType());
        await expect(readProjectTextFile(root, 'linked.txt'))
          .rejects.toThrow('Project path escapes project root through a symlink');
        await expect(writeProjectTextFile(root, {
          projectRelativePath: 'linked.txt',
          content: 'changed',
          expectedRevision: 'linked-revision'
        }))
          .rejects.toThrow('Project path must not be a symbolic link');
        await expect(readFile(join(outside, 'linked.txt'), 'utf8')).resolves.toBe('outside');
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('saves text atomically with revision checks and preserves file permissions', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-text-atomic-'));
      try {
        await mkdir(join(root, 'notes'), { recursive: true });
        const path = join(root, 'notes/brief.md');
        await writeFile(path, '# Draft\n', 'utf8');
        await chmod(path, 0o764);
        const opened = await readProjectTextFile(root, 'notes/brief.md');

        const saved = await writeProjectTextFile(root, {
          projectRelativePath: 'notes/brief.md',
          content: '# Saved with a different size\n',
          expectedRevision: opened.revision
        });

        expect(saved.content).toBe('# Saved with a different size\n');
        expect((await stat(path)).mode & 0o777).toBe(0o764);
        await expect(writeProjectTextFile(root, {
          projectRelativePath: 'notes/brief.md',
          content: '# Stale overwrite\n',
          expectedRevision: opened.revision
        })).rejects.toMatchObject({ code: 'project_file_revision_conflict' });
        await expect(readFile(path, 'utf8')).resolves.toBe('# Saved with a different size\n');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects equal-length external text changes even when the file timestamp is preserved', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-text-content-revision-'));
      try {
        const path = join(root, 'brief.md');
        await writeFile(path, 'first', 'utf8');
        const opened = await readProjectTextFile(root, 'brief.md');

        await writeFile(path, 'other', 'utf8');
        await utimes(path, opened.mtimeMs / 1000, opened.mtimeMs / 1000);

        await expect(writeProjectTextFile(root, {
          projectRelativePath: 'brief.md',
          content: 'local',
          expectedRevision: opened.revision
        })).rejects.toMatchObject({ code: 'project_file_revision_conflict' });
        await expect(readFile(path, 'utf8')).resolves.toBe('other');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('returns a committed save even when the new UTF-8 content exceeds open-time text limits', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-text-large-save-'));
      try {
        const path = join(root, 'brief.md');
        await writeFile(path, '# Draft\n', 'utf8');
        const opened = await readProjectTextFile(root, 'brief.md');
        const content = `${'x'.repeat(1024 * 1024)}\uFFFD`;

        const saved = await writeProjectTextFile(root, {
          projectRelativePath: 'brief.md',
          content,
          expectedRevision: opened.revision
        });

        expect(saved.content).toBe(content);
        expect(saved.size).toBe(Buffer.byteLength(content));
        await expect(readFile(path, 'utf8')).resolves.toBe(content);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('reads project binary files without a default size cap', async () => {
      const root = await mkdtemp(join(tmpdir(), 'debrute-project-large-binary-'));
      try {
        const bytes = Buffer.alloc(20 * 1024 * 1024 + 1, 7);
        await writeFile(join(root, 'large.bin'), bytes);
        const result = await readProjectFileBytes(root, 'large.bin');
        expect(result.byteLength).toBe(bytes.byteLength);
        expect(result[0]).toBe(7);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('App Server project watch events', () => {
    it('does not consume external events without an internal write receipt', async () => {
      const event: NormalizedFileWatchEvent = {
        type: 'changed',
        absolutePath: '/project/notes.md',
        projectRelativePath: 'notes.md',
        observedAt: 100,
        affects: ['content']
      };
      await expect(consumeInternalProjectFileWatchEvent({
        event,
        receipts: new Map()
      })).resolves.toBe(false);
    });

    it('consumes a committed text-save receipt without swallowing a later external write', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-save-watch-receipt-'));
      const server = new DebruteAppServer();
      try {
        await writeFile(join(projectRoot, 'brief.md'), '# Before\n', 'utf8');
        await server.openProject(projectRoot, {
          initializeIfMissing: true,
          createDefaultCanvas: true,
          watchFiles: true
        });

        let resolveProbe!: () => void;
        const probeObserved = new Promise<void>((resolve) => {
          resolveProbe = resolve;
        });
        const changedPaths: string[] = [];
        const unsubscribe = server.onEvent((event) => {
          if (event.type !== 'project.fileChanged') {
            return;
          }
          changedPaths.push(event.event.projectRelativePath);
          if (event.event.projectRelativePath === 'watch-probe.md') {
            resolveProbe();
          }
        });
        await writeFile(join(projectRoot, 'watch-probe.md'), 'ready\n', 'utf8');
        await Promise.race([
          probeObserved,
          waitForProjectWatcherPoll(1_000).then(() => {
            throw new Error('Project watcher did not report the readiness probe.');
          })
        ]);
        changedPaths.length = 0;

        const opened = await server.readProjectTextFile('brief.md');
        await server.writeProjectTextFile({
          projectRelativePath: 'brief.md',
          content: '# Saved\n',
          expectedRevision: opened.revision
        });
        await waitForProjectWatcherPoll(100);

        expect(changedPaths.filter((path) => path === 'brief.md')).toEqual(['brief.md']);

        const externalObservedAt = Date.now() + 1_000;
        await writeFile(join(projectRoot, 'brief.md'), '# Saved\n', 'utf8');
        await utimes(join(projectRoot, 'brief.md'), externalObservedAt / 1_000, externalObservedAt / 1_000);
        await callWatchedFileEvent(server, {
          type: 'changed',
          absolutePath: join(projectRoot, 'brief.md'),
          projectRelativePath: 'brief.md',
          observedAt: externalObservedAt,
          affects: ['content']
        });

        expect(changedPaths.filter((path) => path === 'brief.md')).toEqual(['brief.md', 'brief.md']);
        unsubscribe();
      } finally {
        server.close();
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('syncs Canvas Map file changes through watched refreshes', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-watch-canvas-map-'));
      const server = new DebruteAppServer({
        canvasNodeLayoutSizeReader: async (input) => {
          if (input.nodeKind === 'directory') {
            return { width: 240, height: 96 };
          }
          return { width: 100, height: 100 };
        }
      });
      try {
        await mkdir(join(projectRoot, 'outputs'), { recursive: true });
        await writeFile(join(projectRoot, 'outputs/a.png'), 'fake', 'utf8');
        await writeFile(join(projectRoot, 'outputs/b.png'), 'fake', 'utf8');
        await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
        await writeCanvasMap(projectRoot, 'canvas-1', [
          'paths:',
          '  - outputs/a.png',
          ''
        ]);
        await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
        const mapPath = join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml');
        await writeFile(mapPath, 'paths:\n  - outputs/b.png\n', 'utf8');
        await callWatchedFileEvent(server, {
          type: 'changed',
          absolutePath: mapPath,
          projectRelativePath: '.debrute/canvas-maps/canvas-1.yaml',
          observedAt: Date.now() + 1000,
          affects: ['canvas-map']
        });
        const snapshot = server.getSnapshot();
        expect(snapshot.files.map((file) => file.projectRelativePath)).toContain('.debrute/canvas-maps/canvas-1.yaml');
        await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toContain('outputs/b.png');
        expect(snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual(['', 'outputs', 'outputs/b.png']);
      } finally {
        server.close();
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('syncs Canvas Map folder rules when a matching file appears through a watched event', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-watch-canvas-map-content-'));
      const server = new DebruteAppServer({
        canvasNodeLayoutSizeReader: async (input) => {
          if (input.nodeKind === 'directory') {
            return { width: 240, height: 96 };
          }
          return { width: 100, height: 100 };
        }
      });
      try {
        await mkdir(join(projectRoot, 'outputs'), { recursive: true });
        await writeFile(join(projectRoot, 'outputs/a.png'), 'fake', 'utf8');
        await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
        await writeCanvasMap(projectRoot, 'canvas-1', [
          'paths:',
          '  - outputs/',
          ''
        ]);
        await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
        const nextFilePath = join(projectRoot, 'outputs/b.png');
        await writeFile(nextFilePath, 'fake', 'utf8');
        await callWatchedFileEvent(server, {
          type: 'changed',
          absolutePath: nextFilePath,
          projectRelativePath: 'outputs/b.png',
          observedAt: Date.now() + 1000,
          affects: ['content']
        });
        const snapshot = server.getSnapshot();
        expect(snapshot.files.map((file) => file.projectRelativePath)).toContain('outputs/b.png');
        expect(snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual([
          '',
          'outputs',
          'outputs/a.png',
          'outputs/b.png'
        ]);
        await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toContain('outputs/b.png');
      } finally {
        server.close();
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('keeps previous Canvas JSON when watched Canvas Map source is invalid', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-watch-invalid-canvas-map-'));
      const server = new DebruteAppServer();
      try {
        await mkdir(join(projectRoot, 'notes'), { recursive: true });
        await writeFile(join(projectRoot, 'notes/a.md'), '# A\n', 'utf8');
        await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
        await writeCanvasMap(projectRoot, 'canvas-1', [
          'paths:',
          '  - notes/a.md',
          ''
        ]);
        await server.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
        const canvasBefore = await readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8');
        const mapPath = join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml');
        await writeFile(mapPath, 'paths:\n  - [broken\n', 'utf8');
        await callWatchedFileEvent(server, {
          type: 'changed',
          absolutePath: mapPath,
          projectRelativePath: '.debrute/canvas-maps/canvas-1.yaml',
          observedAt: Date.now() + 1000,
          affects: ['canvas-map']
        });
        const snapshot = server.getSnapshot();
        expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({
            source: 'project',
            severity: 'error',
            code: 'document_invalid_source',
            filePath: mapPath,
            entityId: 'canvas-1'
          })
        ]));
        await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toBe(canvasBefore);
      } finally {
        server.close();
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('emits one project revision event for one external watched file change', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-watch-single-revision-'));
      const server = new DebruteAppServer();
      const events: string[] = [];
      try {
        await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
        await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
        server.onEvent((event) => events.push(event.type));
        const briefPath = join(projectRoot, 'brief.md');
        const observedAt = Date.now() + 1000;
        await writeFile(briefPath, '# Updated', 'utf8');
        await utimes(briefPath, observedAt / 1000, observedAt / 1000);
        await callWatchedFileEvent(server, {
          type: 'changed',
          absolutePath: briefPath,
          projectRelativePath: 'brief.md',
          observedAt,
          affects: ['content']
        });
        expect(events).toEqual(['project.fileChanged']);
      } finally {
        server.close();
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('keeps committed invalid project metadata as a successful save with one refresh diagnostic', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-save-invalid-project-metadata-'));
      const server = new DebruteAppServer();
      try {
        await server.openProject(projectRoot, {
          initializeIfMissing: true,
          createDefaultCanvas: true,
          watchFiles: false
        });
        const original = await server.readProjectTextFile('.debrute/project.json');

        const firstInvalid = await server.writeProjectTextFile({
          projectRelativePath: '.debrute/project.json',
          content: '{',
          expectedRevision: original.revision
        });
        expect(firstInvalid.content).toBe('{');
        expect(server.getSnapshot().metadata.project.name).toBeTruthy();
        expect(server.getSnapshot().diagnostics.filter((diagnostic) => (
          diagnostic.code === 'project.watch.refresh_failed'
          && diagnostic.filePath === join(projectRoot, '.debrute/project.json')
        ))).toHaveLength(1);

        const secondInvalid = await server.writeProjectTextFile({
          projectRelativePath: '.debrute/project.json',
          content: 'not-json',
          expectedRevision: firstInvalid.revision
        });
        expect(secondInvalid.content).toBe('not-json');
        expect(server.getSnapshot().diagnostics.filter((diagnostic) => (
          diagnostic.code === 'project.watch.refresh_failed'
          && diagnostic.filePath === join(projectRoot, '.debrute/project.json')
        ))).toHaveLength(1);

        const corrected = await server.writeProjectTextFile({
          projectRelativePath: '.debrute/project.json',
          content: original.content,
          expectedRevision: secondInvalid.revision
        });
        expect(corrected.content).toBe(original.content);
        expect(server.getSnapshot().diagnostics.some((diagnostic) => (
          diagnostic.code === 'project.watch.refresh_failed'
          && diagnostic.filePath === join(projectRoot, '.debrute/project.json')
        ))).toBe(false);
      } finally {
        server.close();
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  });
  async function callWatchedFileEvent(server: DebruteAppServer, event: NormalizedFileWatchEvent): Promise<void> {
    await (server as unknown as {
      handleWatchedFileEvent(event: NormalizedFileWatchEvent): Promise<void>;
    }).handleWatchedFileEvent(event);
  }

  async function writeCanvasMap(projectRoot: string, canvasId: string, lines: string[]): Promise<void> {
    await mkdir(join(projectRoot, '.debrute/canvas-maps'), { recursive: true });
    await writeFile(join(projectRoot, `.debrute/canvas-maps/${canvasId}.yaml`), lines.join('\n'), 'utf8');
  }

  it('checks non-empty project files through the app-server boundary', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-project-file-exists-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      await mkdir(join(projectRoot, 'generated'), { recursive: true });
      await writeFile(join(projectRoot, 'generated/full.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'generated/empty.png'), '', 'utf8');
      await expect(server.projectFileExistsWithContent({ projectRelativePath: 'generated/full.png' })).resolves.toBe(true);
      await expect(server.projectFileExistsWithContent({ projectRelativePath: 'generated/empty.png' })).resolves.toBe(false);
      await expect(server.projectFileExistsWithContent({ projectRelativePath: 'generated/missing.png' })).resolves.toBe(false);
      await expect(server.projectFileExistsWithContent({ projectRelativePath: '../outside.png' }))
        .rejects.toThrow('Project path must not contain "." or ".." segments');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('mutates project files and returns refreshed snapshots', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-file-ops-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      const directory = await server.createProjectDirectory({ parentProjectRelativePath: '', name: 'briefs' });
      expect(directory.projectRelativePath).toBe('briefs');
      expect(directory.kind).toBe('directory');
      expect(directory.snapshot.files.map((file) => file.projectRelativePath)).toContain('briefs');
      const file = await server.createProjectFile({ parentProjectRelativePath: 'briefs', name: 'concept.md' });
      expect(file.projectRelativePath).toBe('briefs/concept.md');
      expect(file.kind).toBe('file');
      expect(file.snapshot.files.map((entry) => entry.projectRelativePath)).toContain('briefs/concept.md');
      const renamed = await server.renameProjectPath({ projectRelativePath: 'briefs/concept.md', name: 'outline.md' });
      expect(renamed.projectRelativePath).toBe('briefs/outline.md');
      expect(renamed.snapshot.files.map((entry) => entry.projectRelativePath)).toContain('briefs/outline.md');
      const copied = await server.copyProjectPaths({
        entries: [{ projectRelativePath: 'briefs/outline.md', kind: 'file' }],
        targetDirectoryProjectRelativePath: 'briefs'
      });
      expect(copied.results).toEqual([
        { sourceProjectRelativePath: 'briefs/outline.md', projectRelativePath: 'briefs/outline copy.md', kind: 'file', status: 'ok' }
      ]);
      expect(copied.snapshot.files.map((entry) => entry.projectRelativePath)).toContain('briefs/outline copy.md');
      const moved = await server.moveProjectPaths({
        entries: [{ projectRelativePath: 'briefs/outline copy.md', kind: 'file' }],
        targetDirectoryProjectRelativePath: ''
      });
      expect(moved.results).toEqual([
        { sourceProjectRelativePath: 'briefs/outline copy.md', projectRelativePath: 'outline copy.md', kind: 'file', status: 'ok' }
      ]);
      expect(moved.snapshot.files.map((entry) => entry.projectRelativePath)).toContain('outline copy.md');
      const deleted = await server.deleteProjectPathsPermanently({
        entries: [{ projectRelativePath: 'outline copy.md', kind: 'file' }]
      });
      expect(deleted.results).toEqual([
        { sourceProjectRelativePath: 'outline copy.md', projectRelativePath: 'outline copy.md', kind: 'file', status: 'ok' }
      ]);
      expect(deleted.snapshot.files.map((entry) => entry.projectRelativePath)).not.toContain('outline copy.md');
      await expect(stat(join(projectRoot, 'outline copy.md'))).rejects.toThrow();
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('refreshes project-visible ordinary file changes without requiring a Canvas Map', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-refresh-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      await mkdir(join(projectRoot, 'notes'), { recursive: true });
      await writeFile(join(projectRoot, 'notes/brief.md'), 'hello\n', 'utf8');
      const snapshot = await server.refreshProject();
      expect(snapshot.files.some((file) => file.projectRelativePath === 'notes/brief.md')).toBe(true);
      expect(snapshot.health.canvasCount).toBe(1);
      expect(snapshot.canvases[0]?.nodeElements).toEqual([]);
      expect(snapshot.diagnostics).toEqual([]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function directoryLinkType(): 'dir' | 'junction' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

async function waitForProjectWatcherReadiness(
  probePath: string,
  getObservedAt: () => number | undefined
): Promise<void> {
  const deadlineAt = Date.now() + 1_000;
  let sequence = 0;
  while (true) {
    const observedAt = getObservedAt();
    if (observedAt !== undefined) {
      if (observedAt <= deadlineAt) {
        return;
      }
      throw new Error(`Project watcher readiness probe was not observed before the deadline: ${probePath}`);
    }
    const now = Date.now();
    if (now >= deadlineAt) {
      throw new Error(`Project watcher readiness probe was not observed before the deadline: ${probePath}`);
    }
    sequence += 1;
    await writeFile(probePath, `${sequence}\n`, 'utf8');
    await waitForProjectWatcherPoll(Math.min(10, deadlineAt - Date.now()));
  }
}

function waitForProjectWatcherPoll(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}
