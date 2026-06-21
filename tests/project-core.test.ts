import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  normalizeFileWatchEvent,
  normalizeProjectRelativePath,
  nextCopyProjectPathName,
  projectFileRevision,
  isKnownProjectTextFilePath,
  projectTextFileTypeForPath,
  projectTextLanguageFromPath,
  projectTextMimeTypeFromPath,
  readProjectFileBytes,
  readProjectTextFile,
  renameProjectPath,
  resolveNoSymlinkExistingProjectPath,
  resolveNoSymlinkProjectPathForWrite,
  resolveProjectPath,
  writeProjectTextFile,
  watchProjectFiles
} from '@debrute/project-core';

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

  it('classifies project file watch events by current Debrute boundaries', () => {
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/canvases/main.json', 'changed').affects).toEqual(['canvas']);
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/project.json', 'changed').affects).toEqual(['project-metadata']);
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/assets/generated-assets-index.json', 'changed').affects).toEqual(['generated-asset-metadata']);
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/assets/generated/record-1.json', 'changed').affects).toEqual(['generated-asset-metadata']);
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/cache/file-fingerprints.json', 'changed').affects).toEqual(['generated-asset-metadata']);
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/cache/canvas-image-previews/preview.jpg', 'changed').affects).toEqual([]);
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/canvases/main.json.lock', 'changed').affects).toEqual([]);
    expect(normalizeFileWatchEvent('/project', '/project/work/items.json', 'changed').affects).toEqual(['content']);
  });

  it('owns project file revision tokens in project-core', () => {
    expect(projectFileRevision(2048, 1001.2)).toBe('1001:2048');
  });

  it('classifies supported project text file formats through one registry', () => {
    const cases: Array<{ path: string; language: string; mimeType: string; firstLine?: string }> = [
      { path: 'batch/requests.jsonl', language: 'jsonl', mimeType: 'application/jsonl' },
      { path: 'batch/results.ndjson', language: 'jsonl', mimeType: 'application/jsonl' },
      { path: 'config/settings.jsonc', language: 'jsonc', mimeType: 'application/jsonc' },
      { path: 'config/.eslintrc', language: 'jsonc', mimeType: 'application/jsonc' },
      { path: 'docs/notes.mdown', language: 'markdown', mimeType: 'text/markdown' },
      { path: 'skills/SKILL.md', language: 'markdown', mimeType: 'text/markdown' },
      { path: 'compose.dev.yml', language: 'yaml', mimeType: 'application/yaml' },
      { path: 'scripts/run.sh', language: 'shell', mimeType: 'text/x-shellscript' },
      { path: '.zshrc', language: 'shell', mimeType: 'text/x-shellscript' },
      { path: 'bin/run', firstLine: '#!/usr/bin/env bash', language: 'shell', mimeType: 'text/x-shellscript' },
      { path: '.env.local', language: 'dotenv', mimeType: 'text/plain' },
      { path: '.editorconfig', language: 'properties', mimeType: 'text/plain' },
      { path: '.gitignore', language: 'plaintext', mimeType: 'text/plain' },
      { path: '.npmrc', language: 'properties', mimeType: 'text/plain' },
      { path: 'logs/debrute.log', language: 'log', mimeType: 'text/plain' },
      { path: 'logs/debrute.log.1', language: 'log', mimeType: 'text/plain' },
      { path: 'Dockerfile', language: 'dockerfile', mimeType: 'text/plain' },
      { path: 'Containerfile.dev', language: 'dockerfile', mimeType: 'text/plain' },
      { path: 'Makefile', language: 'makefile', mimeType: 'text/plain' },
      { path: 'build/rules.mk', language: 'makefile', mimeType: 'text/plain' },
      { path: 'patches/fix.patch', language: 'diff', mimeType: 'text/plain' },
      { path: 'data/table.tsv', language: 'tsv', mimeType: 'text/tab-separated-values' },
      { path: 'src/module.mts', language: 'typescript', mimeType: 'text/typescript' },
      { path: 'scripts/build.py', language: 'python', mimeType: 'text/x-python' },
      { path: 'LICENSE', language: 'plaintext', mimeType: 'text/plain' }
    ];

    for (const item of cases) {
      expect(projectTextLanguageFromPath(item.path, item.firstLine)).toBe(item.language);
      expect(projectTextMimeTypeFromPath(item.path, item.firstLine)).toBe(item.mimeType);
      expect(isKnownProjectTextFilePath(item.path, item.firstLine)).toBe(true);
      expect(projectTextFileTypeForPath(item.path, item.firstLine)).toMatchObject({
        id: item.language,
        mimeType: item.mimeType
      });
    }

    expect(isKnownProjectTextFilePath('assets/cover.png')).toBe(false);
    expect(isKnownProjectTextFilePath('assets/icon.svg')).toBe(false);
    expect(isKnownProjectTextFilePath('archives/export.debrutebin')).toBe(false);
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
      await mkdir(join(root, '.debrute/cache/canvas-image-previews'), { recursive: true });
      await mkdir(join(root, 'images'), { recursive: true });
      await writeFile(join(root, '.debrute/cache/canvas-image-previews/preview.jpg'), 'cache', 'utf8');
      await writeFile(join(root, 'images/source.png'), 'source', 'utf8');

      const paths = (await listDebruteProjectFiles(root)).map((file) => file.projectRelativePath);

      expect(paths).toContain('images/source.png');
      expect(paths).not.toContain('.debrute/cache/canvas-image-previews');
      expect(paths).not.toContain('.debrute/cache/canvas-image-previews/preview.jpg');
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
      await chmod(unreadableCacheDir, 0o000);

      const paths = (await listDebruteProjectFiles(root)).map((file) => file.projectRelativePath);

      expect(paths).toContain('images/source.png');
      expect(paths.some((path) => path.startsWith('.debrute/cache/canvas-image-previews'))).toBe(false);
    } finally {
      await chmod(unreadableCacheDir, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('emits debounced watcher events for project-visible files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-watch-'));
    let handle: ReturnType<typeof watchProjectFiles> | undefined;
    try {
      await mkdir(join(root, 'notes'), { recursive: true });
      const eventPromise = new Promise<string>((resolve) => {
        handle = watchProjectFiles(root, (event) => {
          if (event.projectRelativePath === 'notes/brief.md') {
            resolve(event.projectRelativePath);
          }
        }, { debounceMs: 5 });
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      await writeFile(join(root, 'notes/brief.md'), 'hello\n', 'utf8');
      await expect(eventPromise).resolves.toBe('notes/brief.md');
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
      await writeFile(join(externalRoot, 'real.txt'), 'real', 'utf8');
      await symlink(join(externalRoot, 'real.txt'), join(externalRoot, 'link.txt'));

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

  it('rejects backslash project paths instead of normalizing them into project separators', () => {
    expect(() => normalizeProjectRelativePath('images\\cover.png'))
      .toThrow('Project path must not contain backslashes');
    expect(() => normalizeProjectRelativePath('..\\outside.txt'))
      .toThrow('Project path must not contain backslashes');
  });

  it('rejects no-symlink existing targets when the final file is a symbolic link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-project-no-symlink-existing-'));
    const externalRoot = await mkdtemp(join(tmpdir(), 'debrute-project-no-symlink-external-'));
    try {
      await mkdir(join(root, '.debrute/cache/canvas-image-previews'), { recursive: true });
      await writeFile(join(externalRoot, 'preview.jpg'), 'external', 'utf8');
      await symlink(join(externalRoot, 'preview.jpg'), join(root, '.debrute/cache/canvas-image-previews/cache.jpg'));

      await expect(resolveNoSymlinkExistingProjectPath(root, '.debrute/cache/canvas-image-previews/cache.jpg'))
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
      await symlink(externalRoot, join(root, '.debrute/canvases'));

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
      await symlink(join(externalRoot, 'outside.txt'), join(root, 'assets/link.txt'));

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
      await mkdir(join(root, '.debrute/cache/canvas-image-previews'), { recursive: true });
      await writeFile(join(root, '.debrute/cache/canvas-image-previews/preview.jpg'), 'cache', 'utf8');

      await expect(createProjectFile(root, {
        parentProjectRelativePath: '.debrute/cache/canvas-image-previews',
        name: 'created.jpg'
      })).rejects.toThrow('Project path is not visible in the Project Tree');
      await expect(copyProjectPaths(root, {
        entries: [{ projectRelativePath: '.debrute/cache/canvas-image-previews/preview.jpg', kind: 'file' }],
        targetDirectoryProjectRelativePath: ''
      })).rejects.toThrow('Project path is not visible in the Project Tree');
      await expect(deleteProjectPathsPermanently(root, {
        entries: [{ projectRelativePath: '.debrute/cache/canvas-image-previews', kind: 'directory' }]
      })).rejects.toThrow('Project path is not visible in the Project Tree');
      await expect(readFile(join(root, '.debrute/cache/canvas-image-previews/preview.jpg'), 'utf8')).resolves.toBe('cache');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects direct text writes to hidden Project Tree paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-project-direct-hidden-write-'));
    try {
      await mkdir(join(root, '.git'), { recursive: true });

      await expect(writeProjectTextFile(root, '.git/config', '[core]\n'))
        .rejects.toThrow('Project path is not visible in the Project Tree');
      expect(existsSync(join(root, '.git/config'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects generic mutations for structured Project Document paths without hiding them from reads', async () => {
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
      await expect(writeProjectTextFile(root, '.debrute/canvases/canvas-1.json', '{"changed":true}\n'))
        .rejects.toThrow('Project path is protected by the Project Document System');
      await expect(deleteProjectPathsPermanently(root, {
        entries: [{ projectRelativePath: '.debrute/canvases/canvas-1.json', kind: 'file' }]
      })).rejects.toThrow('Project path is protected by the Project Document System');
      await expect(readFile(join(root, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toBe('{}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exposes the Project Tree mutation visibility boundary for desktop actions', () => {
    expect(() => assertProjectTreeVisibleMutationPath('assets/cover.png')).not.toThrow();
    expect(() => assertProjectTreeVisibleMutationPath('.debrute/cache/canvas-image-previews/preview.jpg'))
      .toThrow('Project path is not visible in the Project Tree');
    expect(() => assertProjectTreeVisibleMutationPath('.debrute/canvases/canvas-1.json'))
      .toThrow('Project path is protected by the Project Document System');
    expect(() => assertProjectTreeVisibleMutationPath('.git/config'))
      .toThrow('Project path is not visible in the Project Tree');
  });

  it('generates repeated copy names for files and extensionless paths', () => {
    expect(nextCopyProjectPathName(new Set(['cover.png']), 'cover.png')).toBe('cover copy.png');
    expect(nextCopyProjectPathName(new Set(['cover.png', 'cover copy.png']), 'cover.png')).toBe('cover copy 2.png');
    expect(nextCopyProjectPathName(new Set(['brief', 'brief copy']), 'brief')).toBe('brief copy 2');
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
    const outside = join(tmpdir(), `debrute-project-outside-${Date.now()}.txt`);
    try {
      await writeFile(outside, 'outside', 'utf8');
      await symlink(outside, join(root, 'linked.txt'));

      await expect(readProjectTextFile(root, 'linked.txt'))
        .rejects.toThrow('Project path escapes project root through a symlink');
      await expect(writeProjectTextFile(root, 'linked.txt', 'changed'))
        .rejects.toThrow('Project path escapes project root through a symlink');
      await expect(readFile(outside, 'utf8')).resolves.toBe('outside');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
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
