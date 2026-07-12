import { describe, expect, it } from 'vitest';
import {
  checkWorkbenchRuntimeHealth,
  readWorkbenchRuntimeState
} from '@debrute/workbench-runtime';
import { ManagedRuntimeHarness } from '../../helpers/managedRuntimeHarness.js';
import { isProcessAlive } from '../../helpers/testPaths.js';

describe('managed Workbench runtime lifecycle', { tags: ['runtime'] }, () => {
  it('launches, registers, reuses, and terminates the real source runtime', async () => {
    await using harness = await ManagedRuntimeHarness.create();

    const started = await harness.start();
    await expect(checkWorkbenchRuntimeHealth(started)).resolves.toBe('healthy');
    await expect(readWorkbenchRuntimeState(harness.paths.statePath)).resolves.toEqual(started);
    expect(isProcessAlive(started.daemonPid)).toBe(true);
    expect(started.webPid === undefined ? false : isProcessAlive(started.webPid)).toBe(true);

    const reused = await harness.start();
    expect(reused.daemonPid).toBe(started.daemonPid);
    expect(reused.webPid).toBe(started.webPid);
    expect(reused.startedAt).toBe(started.startedAt);

    await harness.terminate();
    expect(isProcessAlive(started.daemonPid)).toBe(false);
    expect(started.webPid === undefined ? false : isProcessAlive(started.webPid)).toBe(false);
  });
});
