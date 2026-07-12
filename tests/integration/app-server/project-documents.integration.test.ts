import { describe, expect, it } from 'vitest';
import {
  projectDocumentDescriptorForPath,
  projectDocumentDescriptors
} from '../../../apps/app-server/src/project-documents/documentDescriptors';
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  commitProjectDocumentTransaction,
  projectDocumentFileHash
} from '../../../apps/app-server/src/project-documents/ProjectDocumentTransaction';
import { DebruteAppServer } from '@debrute/app-server';

describe('app-server project documents', () => {
  describe('Project document descriptors', () => {
    it('declares app-server structured .debrute document roles and owners', () => {
      expect(projectDocumentDescriptors.map((descriptor) => ({
        type: descriptor.type,
        pathPattern: descriptor.pathPattern,
        role: descriptor.role,
        owners: descriptor.owners
      }))).toEqual([
        { type: 'canvas-map', pathPattern: '.debrute/canvas-maps/<canvas-id>.yaml', role: 'source', owners: ['canvas-map', 'canvas-registry'] },
        { type: 'canvas-registry', pathPattern: '.debrute/canvases/index.json', role: 'source', owners: ['canvas-registry'] },
        { type: 'canvas-document', pathPattern: '.debrute/canvases/<canvas-id>.json', role: 'pushed', owners: ['canvas', 'canvas-map', 'canvas-registry'] },
        { type: 'canvas-feedback', pathPattern: '.debrute/reviews/canvas-feedback.json', role: 'metadata', owners: ['canvas-feedback'] },
        { type: 'generated-asset-index', pathPattern: '.debrute/assets/generated-assets-index.json', role: 'metadata', owners: ['generated-assets'] },
        { type: 'generated-asset-record', pathPattern: '.debrute/assets/generated/<record-id>.json', role: 'metadata', owners: ['generated-assets'] },
        { type: 'fingerprint-cache', pathPattern: '.debrute/cache/file-fingerprints.json', role: 'cache', owners: ['generated-assets'] }
      ]);
      expect(projectDocumentDescriptors.every((descriptor) => !Object.hasOwn(descriptor, 'rebuildability'))).toBe(true);
      expect(projectDocumentDescriptors.every((descriptor) => !Object.hasOwn(descriptor, 'writeMode'))).toBe(true);
    });

    it('routes known .debrute paths to descriptors', () => {
      expect(projectDocumentDescriptorForPath('.debrute/project.json')).toBeUndefined();
      expect(projectDocumentDescriptorForPath('.debrute/canvas-maps/canvas-1.yaml')?.type).toBe('canvas-map');
      expect(projectDocumentDescriptorForPath('.debrute/canvases/index.json')?.type).toBe('canvas-registry');
      expect(projectDocumentDescriptorForPath('.debrute/canvases/canvas-1.json')?.type).toBe('canvas-document');
      expect(projectDocumentDescriptorForPath('.debrute/reviews/canvas-feedback.json')?.type).toBe('canvas-feedback');
      expect(projectDocumentDescriptorForPath('.debrute/assets/generated-assets-index.json')?.type).toBe('generated-asset-index');
      expect(projectDocumentDescriptorForPath('.debrute/assets/generated/record-1.json')?.type).toBe('generated-asset-record');
      expect(projectDocumentDescriptorForPath('.debrute/cache/file-fingerprints.json')?.type).toBe('fingerprint-cache');
      expect(projectDocumentDescriptorForPath('.debrute/cache/canvas-image-previews/a/b.webp')).toBeUndefined();
      expect(projectDocumentDescriptorForPath('.debrute/unknown/state.json')).toBeUndefined();
      expect(projectDocumentDescriptorForPath('.debrute/canvas-maps/nested/canvas-1.yaml')).toBeUndefined();
      expect(projectDocumentDescriptorForPath('.debrute/canvas-maps/bad.id.yaml')).toBeUndefined();
      expect(projectDocumentDescriptorForPath('.debrute/canvases/nested/canvas-1.json')).toBeUndefined();
      expect(projectDocumentDescriptorForPath('.debrute/assets/generated/nested/record-1.json')).toBeUndefined();
      expect(projectDocumentDescriptorForPath('.debrute/assets/generated/../escape.json')).toBeUndefined();
    });
  });

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
                recordInternalWrite: (_path, content) => {
                  if (content === '{"id":"canvas-1","before":true}\n') {
                    throw new Error('rollback callback failed');
                  }
                }
              },
              {
                absolutePath: second,
                content: '{"id":"canvas-2","after":true}\n',
                recordInternalWrite: () => {
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
        await symlink(loop, loop, directoryLinkType());
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
        await symlink(externalRoot, join(root, '.debrute/canvases'), directoryLinkType());
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
        await symlink(externalRoot, join(root, '.debrute/canvases'), directoryLinkType());
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

  it('saves source Project Documents through the uniform revisioned text path', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-source-doc-text-write-'));
    const server = new DebruteAppServer();
    try {
      await mkdir(join(projectRoot, 'notes'), { recursive: true });
      await writeFile(join(projectRoot, 'notes/brief.md'), '# Brief\n', 'utf8');
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      const sourcePath = join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml');
      const opened = await server.readProjectTextFile('.debrute/canvas-maps/canvas-1.yaml');
      await writeFile(`${sourcePath}.lock`, '', 'utf8');
      const written = await server.writeProjectTextFile({
        projectRelativePath: '.debrute/canvas-maps/canvas-1.yaml',
        content: canvasMapSource(['notes/brief.md']),
        expectedRevision: opened.revision
      });
      expect(written.projectRelativePath).toBe('.debrute/canvas-maps/canvas-1.yaml');
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe(canvasMapSource(['notes/brief.md']));
      expect(server.getSnapshot().canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual([
        '',
        'notes',
        'notes/brief.md'
      ]);
      await expect(readFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), 'utf8')).resolves.toContain('notes/brief.md');
      await rm(`${sourcePath}.lock`, { force: true });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('saves every visible Project Document metadata role through the same revisioned text path', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-metadata-text-write-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });
      await mkdir(join(projectRoot, '.debrute/reviews'), { recursive: true });
      await mkdir(join(projectRoot, '.debrute/assets'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/reviews/canvas-feedback.json'), JSON.stringify({
        updatedAt: '2026-07-12T00:00:00.000Z',
        entries: {}
      }), 'utf8');
      await writeFile(join(projectRoot, '.debrute/assets/generated-assets-index.json'), JSON.stringify({
        records: []
      }), 'utf8');

      for (const projectRelativePath of [
        '.debrute/canvases/index.json',
        '.debrute/reviews/canvas-feedback.json',
        '.debrute/assets/generated-assets-index.json'
      ]) {
        const opened = await server.readProjectTextFile(projectRelativePath);
        const content = `${opened.content} `;
        const written = await server.writeProjectTextFile({
          projectRelativePath,
          content,
          expectedRevision: opened.revision
        });
        expect(written.content).toBe(content);
        await expect(readFile(join(projectRoot, projectRelativePath), 'utf8')).resolves.toBe(content);
      }
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('commits invalid pushed Project Document text and reports it through project diagnostics', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-pushed-doc-text-write-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      const canvasPath = join(projectRoot, '.debrute/canvases/canvas-1.json');
      const opened = await server.readProjectTextFile('.debrute/canvases/canvas-1.json');
      const written = await server.writeProjectTextFile({
        projectRelativePath: '.debrute/canvases/canvas-1.json',
        content: '{}\n',
        expectedRevision: opened.revision
      });
      expect(written.content).toBe('{}\n');
      await expect(readFile(canvasPath, 'utf8')).resolves.toBe('{}\n');
      expect(server.getSnapshot().diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'document_invalid_pushed',
          filePath: canvasPath,
          entityId: 'canvas-1'
        })
      ]));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('commits invalid Canvas Map and registry text while publishing their normal diagnostic states', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-invalid-source-text-write-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });

      const mapPath = '.debrute/canvas-maps/canvas-1.yaml';
      const openedMap = await server.readProjectTextFile(mapPath);
      const writtenMap = await server.writeProjectTextFile({
        projectRelativePath: mapPath,
        content: 'paths: [\n',
        expectedRevision: openedMap.revision
      });
      expect(writtenMap.content).toBe('paths: [\n');
      expect(server.getSnapshot().diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'document_invalid_source', entityId: 'canvas-1' })
      ]));

      const registryPath = '.debrute/canvases/index.json';
      const openedRegistry = await server.readProjectTextFile(registryPath);
      const writtenRegistry = await server.writeProjectTextFile({
        projectRelativePath: registryPath,
        content: '{}\n',
        expectedRevision: openedRegistry.revision
      });
      expect(writtenRegistry.content).toBe('{}\n');
      expect(server.getSnapshot().canvasRegistry).toMatchObject({
        status: 'invalid',
        code: 'canvas_registry_invalid'
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
  function canvasMapSource(paths: Array<string | {
    glob: string;
  }>, layoutRows: string[] = []): string {
    return [
      'paths:',
      ...paths.map((path) => typeof path === 'string' ? `  - ${path}` : `  - glob: ${path.glob}`),
      ...(layoutRows.length === 0
        ? []
        : [
          'layout:',
          '  rows:',
          ...layoutRows.map((row) => `    - ${row}`)
        ]),
      ''
    ].join('\n');
  }
});

function directoryLinkType(): 'dir' | 'junction' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}
