import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkbenchRuntimePaths } from '../../../packages/workbench-runtime/src/paths.js';
import {
  readWorkbenchRuntimeState,
  writeWorkbenchRuntimeState,
  type WorkbenchRuntimeState
} from '../../../packages/workbench-runtime/src/state.js';

describe('@debrute/workbench-runtime state', { tags: ['runtime'] }, () => {
  it('round-trips the current runtime state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-state-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const state = runtimeState({ daemonLogPath: paths.daemonLogPath, webLogPath: paths.webLogPath });

      await writeWorkbenchRuntimeState(paths.statePath, state);

      await expect(readWorkbenchRuntimeState(paths.statePath)).resolves.toEqual(state);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed current runtime state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-state-invalid-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(paths.statePath, JSON.stringify({
        runtimeKind: 'source-dev',
        processControl: 'managed',
        daemonUrl: 'http://127.0.0.1:17321'
      }), 'utf8');

      await expect(readWorkbenchRuntimeState(paths.statePath)).rejects.toThrow(/owner/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires owner metadata in current runtime state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-owner-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const invalid = runtimeState() as unknown as Record<string, unknown>;
      delete invalid.owner;
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(paths.statePath, JSON.stringify(invalid), 'utf8');

      await expect(readWorkbenchRuntimeState(paths.statePath)).rejects.toThrow(/owner/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects non-loopback URLs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-state-network-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(paths.statePath, JSON.stringify(runtimeState({
        daemonUrl: 'http://192.168.1.2:17321',
        webUrl: 'http://127.0.0.1:17322'
      })), 'utf8');

      await expect(readWorkbenchRuntimeState(paths.statePath)).rejects.toThrow(/loopback/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects project URLs in runtime base URL fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-state-project-url-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(paths.statePath, JSON.stringify(runtimeState({
        webUrl: 'http://127.0.0.1:17322/projects/project-1'
      })), 'utf8');

      await expect(readWorkbenchRuntimeState(paths.statePath)).rejects.toThrow(/origin/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function runtimeState(overrides: Partial<WorkbenchRuntimeState> = {}): WorkbenchRuntimeState {
  return {
    runtimeKind: 'source-dev',
    processControl: 'managed',
    owner: { kind: 'cli', ownerId: 'owner-1', pid: 100 },
    daemonUrl: 'http://127.0.0.1:17321',
    webUrl: 'http://127.0.0.1:17322',
    token: 'secret',
    daemonPid: 10,
    webPid: 11,
    daemonLogPath: '/home/user/.debrute/runtime/workbench-daemon.log',
    webLogPath: '/home/user/.debrute/runtime/workbench-web.log',
    startedAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    ...overrides
  };
}
