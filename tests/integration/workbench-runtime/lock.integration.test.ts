import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkbenchRuntimePaths } from '../../../packages/workbench-runtime/src/paths.js';
import { acquireWorkbenchRuntimeStartupLock } from '../../../packages/workbench-runtime/src/lock.js';

describe('@debrute/workbench-runtime lock', { tags: ['runtime'] }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serializes publishers with the startup lock', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-lock-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const events: string[] = [];
      const first = await acquireWorkbenchRuntimeStartupLock(paths);
      const waiting = acquireWorkbenchRuntimeStartupLock(paths).then((second) => {
        events.push('second-acquired');
        return second.release();
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual([]);
      await first.release();
      await vi.waitFor(() => expect(events).toEqual(['second-acquired']));
      await waiting;
      expect(events).toEqual(['second-acquired']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
