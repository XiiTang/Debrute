import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commitProjectDocumentTransaction,
  projectDocumentFileHash
} from '../apps/app-server/src/project-documents/ProjectDocumentTransaction';

describe('ProjectDocumentTransaction', () => {
  it('commits staged text writes after verifying read hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-'));
    try {
      const file = join(root, '.debrute/canvases/canvas-1.json');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '{"before":true}\n', 'utf8');
      const hash = await projectDocumentFileHash(file);

      await commitProjectDocumentTransaction({
        projectRoot: root,
        owner: 'canvas',
        reads: [{ absolutePath: file, expectedHash: hash }],
        writes: [{ absolutePath: file, content: '{"after":true}\n' }]
      });

      await expect(readFile(file, 'utf8')).resolves.toBe('{"after":true}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a transaction when another writer holds a target lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-lock-'));
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const file = join(root, '.debrute/canvases/canvas-1.json');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '{"before":true}\n', 'utf8');
      const hash = await projectDocumentFileHash(file);
      lock = await open(`${file}.lock`, 'wx');

      await expect(commitProjectDocumentTransaction({
        projectRoot: root,
        owner: 'canvas',
        reads: [{ absolutePath: file, expectedHash: hash }],
        writes: [{ absolutePath: file, content: '{"after":true}\n' }]
      })).rejects.toMatchObject({ code: 'document_push_conflict' });

      await expect(readFile(file, 'utf8')).resolves.toBe('{"before":true}\n');
    } finally {
      await lock?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('aborts all writes when a verified file changed after read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-conflict-'));
    try {
      const source = join(root, '.debrute/canvas-maps/canvas-1.yaml');
      const pushed = join(root, '.debrute/canvases/canvas-1.json');
      await mkdir(dirname(source), { recursive: true });
      await mkdir(dirname(pushed), { recursive: true });
      await writeFile(source, 'paths: []\n', 'utf8');
      await writeFile(pushed, '{"nodeElements":[]}\n', 'utf8');
      const sourceHash = await projectDocumentFileHash(source);
      await writeFile(source, 'paths:\n  - changed.md\n', 'utf8');

      await expect(commitProjectDocumentTransaction({
        projectRoot: root,
        owner: 'canvas-map',
        reads: [{ absolutePath: source, expectedHash: sourceHash }],
        writes: [{ absolutePath: pushed, content: '{"nodeElements":["changed.md"]}\n' }]
      })).rejects.toMatchObject({ code: 'document_push_conflict' });

      await expect(readFile(pushed, 'utf8')).resolves.toBe('{"nodeElements":[]}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans staged temp files when commit fails before rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-cleanup-'));
    try {
      const file = join(root, '.debrute/canvases/canvas-1.json');
      await mkdir(file, { recursive: true });

      await expect(commitProjectDocumentTransaction({
        projectRoot: root,
        owner: 'canvas',
        reads: [],
        writes: [{ absolutePath: file, content: '{"after":true}\n' }]
      })).rejects.toBeDefined();

      await expect(readFile(file, 'utf8')).rejects.toBeDefined();
      await expect(readdir(dirname(file))).resolves.toEqual(['canvas-1.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves all previous documents visible when one target cannot be committed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-rollback-'));
    try {
      const first = join(root, '.debrute/canvases/canvas-1.json');
      const second = join(root, '.debrute/canvases/canvas-2.json');
      await mkdir(dirname(first), { recursive: true });
      await writeFile(first, '{"id":"canvas-1","before":true}\n', 'utf8');
      await mkdir(second, { recursive: true });

      await expect(commitProjectDocumentTransaction({
        projectRoot: root,
        owner: 'canvas',
        reads: [],
        writes: [
          { absolutePath: first, content: '{"id":"canvas-1","after":true}\n' },
          { absolutePath: second, content: '{"id":"canvas-2","after":true}\n' }
        ]
      })).rejects.toBeDefined();

      await expect(readFile(first, 'utf8')).resolves.toBe('{"id":"canvas-1","before":true}\n');
      await expect(readdir(second)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('releases locks when rollback cleanup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-rollback-lock-'));
    try {
      const first = join(root, '.debrute/canvases/canvas-1.json');
      const second = join(root, '.debrute/canvases/canvas-2.json');
      await mkdir(dirname(first), { recursive: true });
      await writeFile(first, '{"id":"canvas-1","before":true}\n', 'utf8');
      await writeFile(second, '{"id":"canvas-2","before":true}\n', 'utf8');

      let error: unknown;
      try {
        await commitProjectDocumentTransaction({
          projectRoot: root,
          owner: 'canvas',
          reads: [],
          writes: [
            {
              absolutePath: first,
              content: '{"id":"canvas-1","after":true}\n',
              suppressInternalEvent: (_path, content) => {
                if (content === '{"id":"canvas-1","before":true}\n') {
                  throw new Error('rollback callback failed');
                }
              }
            },
            {
              absolutePath: second,
              content: '{"id":"canvas-2","after":true}\n',
              suppressInternalEvent: () => {
                throw new Error('commit callback failed');
              }
            }
          ]
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeDefined();
      await expect(readFile(`${first}.lock`, 'utf8')).rejects.toBeDefined();
      await expect(readFile(`${second}.lock`, 'utf8')).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects writes outside the registered project document descriptors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-descriptor-'));
    try {
      await expect(commitProjectDocumentTransaction({
        projectRoot: root,
        owner: 'canvas',
        reads: [],
        writes: [{ absolutePath: join(root, '.debrute/unknown/state.json'), content: '{}\n' }]
      })).rejects.toMatchObject({ code: 'document_descriptor_violation' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects project document writes by the wrong owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-owner-'));
    try {
      await expect(commitProjectDocumentTransaction({
        projectRoot: root,
        owner: 'generated-assets',
        reads: [],
        writes: [{ absolutePath: join(root, '.debrute/canvases/canvas-1.json'), content: '{}\n' }]
      })).rejects.toMatchObject({ code: 'document_descriptor_violation' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unregistered transaction reads before mutating registered documents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-read-boundary-'));
    const externalRoot = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-read-boundary-external-'));
    try {
      const file = join(root, '.debrute/canvases/canvas-1.json');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '{"before":true}\n', 'utf8');
      const externalFile = join(externalRoot, 'outside.json');
      await writeFile(externalFile, '{}\n', 'utf8');

      await expect(commitProjectDocumentTransaction({
        projectRoot: root,
        owner: 'canvas',
        reads: [{ absolutePath: externalFile, expectedHash: null }],
        writes: [{ absolutePath: file, content: '{"after":true}\n' }]
      })).rejects.toMatchObject({ code: 'document_descriptor_violation' });

      await expect(readFile(file, 'utf8')).resolves.toBe('{"before":true}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  it('propagates non-missing realpath failures before mutating registered documents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-realpath-error-'));
    const externalRoot = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-realpath-error-external-'));
    try {
      const file = join(root, '.debrute/canvases/canvas-1.json');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '{"before":true}\n', 'utf8');

      const loop = join(externalRoot, 'loop');
      await symlink(loop, loop);

      let error: unknown;
      try {
        await commitProjectDocumentTransaction({
          projectRoot: root,
          owner: 'canvas',
          reads: [{ absolutePath: join(loop, '.debrute/canvases/canvas-1.json'), expectedHash: null }],
          writes: [{ absolutePath: file, content: '{"after":true}\n' }]
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({ code: 'document_push_failed' });
      expect(error).not.toMatchObject({ code: 'document_descriptor_violation' });
      await expect(readFile(file, 'utf8')).resolves.toBe('{"before":true}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  it('rejects structured document writes through symlinked descriptor directories before outside mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-symlink-write-'));
    const externalRoot = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-symlink-write-external-'));
    try {
      await mkdir(join(root, '.debrute'), { recursive: true });
      await symlink(externalRoot, join(root, '.debrute/canvases'));

      await expect(commitProjectDocumentTransaction({
        projectRoot: root,
        owner: 'canvas',
        reads: [],
        writes: [{ absolutePath: join(root, '.debrute/canvases/canvas-1.json'), content: '{"unsafe":true}\n' }]
      })).rejects.toMatchObject({ code: 'document_push_failed' });

      await expect(readFile(join(externalRoot, 'canvas-1.json'), 'utf8')).rejects.toBeDefined();
      await expect(readdir(externalRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  it('rejects structured document deletes through symlinked descriptor directories before outside mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-symlink-delete-'));
    const externalRoot = await mkdtemp(join(tmpdir(), 'debrute-doc-tx-symlink-delete-external-'));
    try {
      await mkdir(join(root, '.debrute'), { recursive: true });
      await writeFile(join(externalRoot, 'canvas-1.json'), '{"external":true}\n', 'utf8');
      await symlink(externalRoot, join(root, '.debrute/canvases'));

      await expect(commitProjectDocumentTransaction({
        projectRoot: root,
        owner: 'canvas',
        reads: [],
        deletes: [{ absolutePath: join(root, '.debrute/canvases/canvas-1.json') }]
      })).rejects.toMatchObject({ code: 'document_push_failed' });

      await expect(readFile(join(externalRoot, 'canvas-1.json'), 'utf8')).resolves.toBe('{"external":true}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});
