import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AxisAppServer } from '@axis/app-server';
import type { ProjectSessionSnapshot } from '@axis/app-protocol';
import { ProjectSessionRegistry } from '../apps/daemon/src/http/ProjectSessionRegistry';

describe('ProjectSessionRegistry', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('deduplicates concurrent opens for the same canonical project root', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-registry-concurrent-root-'));
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
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-registry-real-root-'));
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
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-registry-duplicate-client-'));
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
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-registry-never-attached-'));
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
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-registry-close-during-open-'));
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

    await expect(opening).rejects.toThrow('AXIS project session registry is closed.');
    expect(registry.list()).toEqual([]);
    expect(closeCount).toBe(1);
  });

  it('rejects new project opens after the registry is closed', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-registry-open-after-close-'));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));
    const registry = new ProjectSessionRegistry({
      createAppServer: () => appServerFixture(async (root) => snapshotFixture(root))
    });

    await registry.close();

    await expect(registry.openProject(projectRoot)).rejects.toThrow('AXIS project session registry is closed.');
    expect(registry.list()).toEqual([]);
  });
});

function appServerFixture(
  openProject: (projectRoot: string) => Promise<ProjectSessionSnapshot>,
  close: () => void = () => undefined
): AxisAppServer {
  return {
    openProject,
    close
  } as unknown as AxisAppServer;
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
    health: {
      projectName: 'Test Project',
      canvasCount: 0,
      diagnosticCounts: { errors: 0, warnings: 0, infos: 0 },
      runtimeDataLocation: 'axis-home',
      checkedAt: '2026-06-03T00:00:00.000Z'
    }
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
