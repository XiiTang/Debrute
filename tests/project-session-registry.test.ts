import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DebruteAppServer } from '@debrute/app-server';
import type { AppServerEvent, ProjectSessionSnapshot } from '@debrute/app-protocol';
import { ProjectSessionRegistry } from '../apps/daemon/src/http/ProjectSessionRegistry';

describe('ProjectSessionRegistry', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('deduplicates concurrent opens for the same canonical project root', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-registry-concurrent-root-'));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));
    let createdAppServers = 0;

    const registry = new ProjectSessionRegistry({
      idleTtlMs: 1000,
      createAppServer: () => {
        createdAppServers += 1;
        return appServerFixture(async (root) => {
          await delay(20);
          return snapshotFixture(root);
        });
      }
    });
    cleanups.push(() => registry.close());

    const [first, second] = await Promise.all([
      registry.openProject(projectRoot),
      registry.openProject(projectRoot)
    ]);

    expect(second.projectId).toBe(first.projectId);
    expect(registry.list()).toHaveLength(1);
    expect(createdAppServers).toBe(1);
  });

  it('deduplicates symlinked project roots by real canonical path', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-registry-real-root-'));
    const linkedRoot = `${projectRoot}-link`;
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    await symlink(projectRoot, linkedRoot, 'dir');
    cleanups.push(
      () => rm(linkedRoot, { recursive: true, force: true }),
      () => rm(projectRoot, { recursive: true, force: true })
    );

    const registry = new ProjectSessionRegistry({
      idleTtlMs: 1000,
      createAppServer: () => appServerFixture(async (root) => snapshotFixture(root))
    });
    cleanups.push(() => registry.close());

    const first = await registry.openProject(projectRoot);
    const second = await registry.openProject(linkedRoot);

    expect(second.projectId).toBe(first.projectId);
    expect(registry.list()).toHaveLength(1);
  });

  it('tracks duplicate client ids as independent live leases', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-registry-duplicate-client-'));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));
    const registry = new ProjectSessionRegistry({
      idleTtlMs: 1000,
      createAppServer: () => appServerFixture(async (root) => snapshotFixture(root))
    });
    cleanups.push(() => registry.close());
    const session = await registry.openProject(projectRoot);

    const releaseFirst = registry.registerClient(session.projectId, { clientId: 'web:client', kind: 'sse' });
    const releaseSecond = registry.registerClient(session.projectId, { clientId: 'web:client', kind: 'sse' });

    expect(registry.list()[0]?.clients.size).toBe(2);
    releaseFirst?.();
    expect(registry.list()[0]?.clients.size).toBe(1);
    releaseSecond?.();
    expect(registry.list()[0]?.clients.size).toBe(0);
  });

  it('releases a never-attached project session after the idle TTL', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-registry-never-attached-'));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));
    let closeCount = 0;
    const registry = new ProjectSessionRegistry({
      idleTtlMs: 20,
      createAppServer: () => appServerFixture(async (root) => snapshotFixture(root), () => {
        closeCount += 1;
      })
    });
    cleanups.push(() => registry.close());

    await registry.openProject(projectRoot);
    await delay(80);

    expect(registry.list()).toEqual([]);
    expect(closeCount).toBe(1);
  });

  it('closes a session that finishes opening after the registry is closed', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-registry-close-during-open-'));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));
    let closeCount = 0;
    let releaseOpen!: () => void;
    let markOpenStarted!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openStarted = new Promise<void>((resolve) => {
      markOpenStarted = resolve;
    });
    const registry = new ProjectSessionRegistry({
      idleTtlMs: 1000,
      createAppServer: () => appServerFixture(async (root) => {
        markOpenStarted();
        await openGate;
        return snapshotFixture(root);
      }, () => {
        closeCount += 1;
      })
    });
    cleanups.push(() => registry.close());

    const opening = registry.openProject(projectRoot);
    await openStarted;
    await registry.close();
    releaseOpen();

    await expect(opening).rejects.toThrow('Debrute project session registry is closed.');
    expect(registry.list()).toEqual([]);
    expect(closeCount).toBe(1);
  });

  it('rejects new project opens after the registry is closed', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-registry-open-after-close-'));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));
    const registry = new ProjectSessionRegistry({
      createAppServer: () => appServerFixture(async (root) => snapshotFixture(root))
    });

    await registry.close();

    await expect(registry.openProject(projectRoot)).rejects.toThrow('Debrute project session registry is closed.');
    expect(registry.list()).toEqual([]);
  });

  it('tracks project revisions from AppServer shared-state events', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-registry-revision-events-'));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));
    const registry = new ProjectSessionRegistry({
      idleTtlMs: 1000,
      createAppServer: () => appServerFixture(async (root) => snapshotFixture(root))
    });
    cleanups.push(() => registry.close());

    const session = await registry.openProject(projectRoot);
    expect(session.projectRevision).toBe(1);
    const appServer = session.appServer as DebruteAppServer & { emitForTest(event: AppServerEvent): void };

    appServer.emitForTest({
      type: 'project.changed',
      snapshot: {
        ...snapshotFixture(projectRoot),
        files: [{ projectRelativePath: 'brief.md', kind: 'file' }]
      }
    });

    expect(registry.get(session.projectId)?.projectRevision).toBe(2);
    expect(registry.get(session.projectId)?.snapshot.files).toHaveLength(1);
  });

  it('serializes revisioned mutations and rejects stale base revisions', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-registry-stale-mutation-'));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));
    const registry = new ProjectSessionRegistry({
      idleTtlMs: 1000,
      createAppServer: () => appServerFixture(async (root) => snapshotFixture(root))
    });
    cleanups.push(() => registry.close());
    const session = await registry.openProject(projectRoot);
    const appServer = session.appServer as DebruteAppServer & { emitForTest(event: AppServerEvent): void };

    const first = await registry.runRevisionedMutation(session.projectId, 1, async () => {
      appServer.emitForTest({
        type: 'project.changed',
        snapshot: {
          ...snapshotFixture(projectRoot),
          files: [{ projectRelativePath: 'first.md', kind: 'file' }]
        }
      });
      return { ok: true as const };
    });

    expect(first.projectRevision).toBe(2);
    await expect(registry.runRevisionedMutation(session.projectId, 1, async () => ({ ok: true as const })))
      .rejects.toMatchObject({
        code: 'stale_project_revision',
        baseRevision: 1,
        projectRevision: 2
      });
  });

  it('drains queued AppServer session events before accepting a base revision', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-registry-pending-event-'));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));
    let mutationRan = false;
    let drainCount = 0;
    const registry = new ProjectSessionRegistry({
      idleTtlMs: 1000,
      createAppServer: () => appServerFixture(async (root) => snapshotFixture(root), () => undefined, {
        drainSessionOperations: async (emit) => {
          drainCount += 1;
          emit({
            type: 'project.changed',
            snapshot: {
              ...snapshotFixture(projectRoot),
              files: [{ projectRelativePath: 'external.md', kind: 'file' }]
            }
          });
        }
      })
    });
    cleanups.push(() => registry.close());
    const session = await registry.openProject(projectRoot);

    await expect(registry.runRevisionedMutation(session.projectId, 1, async () => {
      mutationRan = true;
      return { ok: true as const };
    })).rejects.toMatchObject({
      code: 'stale_project_revision',
      baseRevision: 1,
      projectRevision: 2
    });
    expect(drainCount).toBe(1);
    expect(mutationRan).toBe(false);
    expect(registry.get(session.projectId)?.snapshot.files).toEqual([
      { projectRelativePath: 'external.md', kind: 'file' }
    ]);
  });

  it('runs non-revisioned project operations after draining queued AppServer session events', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-registry-project-operation-'));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));
    let drainCount = 0;
    const registry = new ProjectSessionRegistry({
      idleTtlMs: 1000,
      createAppServer: () => appServerFixture(async (root) => snapshotFixture(root), () => undefined, {
        drainSessionOperations: async (emit) => {
          drainCount += 1;
          emit({
            type: 'project.changed',
            snapshot: {
              ...snapshotFixture(projectRoot),
              files: [{ projectRelativePath: 'external.md', kind: 'file' }]
            }
          });
        }
      })
    });
    cleanups.push(() => registry.close());
    const session = await registry.openProject(projectRoot);

    const result = await registry.runProjectOperation(session.projectId, async (record) => ({
      snapshot: record.snapshot
    }));

    expect(result.projectRevision).toBe(2);
    expect(result.snapshot.files).toEqual([{ projectRelativePath: 'external.md', kind: 'file' }]);
    expect(drainCount).toBe(1);
  });
});

function appServerFixture(
  openProject: (projectRoot: string) => Promise<ProjectSessionSnapshot>,
  close: () => void = () => undefined,
  options: {
    drainSessionOperations?: (emit: (event: AppServerEvent) => void) => Promise<void> | void;
  } = {}
): DebruteAppServer & { emitForTest(event: AppServerEvent): void } {
  const listeners = new Set<(event: AppServerEvent) => void>();
  const emitForTest = (event: AppServerEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  return {
    openProject,
    close,
    drainSessionOperations: async () => {
      await options.drainSessionOperations?.(emitForTest);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitForTest
  } as unknown as DebruteAppServer & { emitForTest(event: AppServerEvent): void };
}

function snapshotFixture(projectRoot: string): ProjectSessionSnapshot {
  return {
    projectRoot,
    metadata: {
      schemaVersion: 1,
      project: {
        id: 'project-record-id',
        name: 'Test Project',
        createdAt: '2026-06-03T00:00:00.000Z',
        updatedAt: '2026-06-03T00:00:00.000Z'
      }
    },
    files: [],
    canvases: [],
    projections: [],
    diagnostics: [],
    canvasRegistry: { status: 'ready', canvasOrder: [] },
    health: {
      projectName: 'Test Project',
      canvasCount: 0,
      diagnosticCounts: { errors: 0, warnings: 0, infos: 0 },
      runtimeDataLocation: 'debrute-home',
      checkedAt: '2026-06-03T00:00:00.000Z'
    }
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
