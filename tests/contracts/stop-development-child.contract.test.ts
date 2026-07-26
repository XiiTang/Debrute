import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
  stopDevelopmentChild,
  throwDevelopmentCleanupFailures
} from '../../scripts/stop-development-child.mjs';

describe('development child cleanup', () => {
  it('terminates and waits for a live POSIX child', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const child = fakeChild(4242);

    await stopDevelopmentChild(child, { label: 'fixture child' });

    expect(child.killedWith).toBe('SIGTERM');
    expect(child.exitCode).toBe(0);
  });

  it('does nothing when the child already exited', async () => {
    const child = fakeChild(4242);
    child.exitCode = 0;

    await stopDevelopmentChild(child, { label: 'fixture child' });

    expect(child.killedWith).toBeUndefined();
  });

  it('rejects when POSIX SIGTERM cannot be sent', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const child = fakeChild(4242);
    child.kill = () => false;

    await expect(stopDevelopmentChild(child, { label: 'fixture child' }))
      .rejects.toThrow('could not send SIGTERM');
  });

  it('rejects a POSIX child error while waiting for exit', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const child = fakeChild(4242);
    child.kill = () => {
      queueMicrotask(() => child.emit('error', new Error('fixture signal error')));
      return true;
    };

    await expect(stopDevelopmentChild(child, { label: 'fixture child' }))
      .rejects.toThrow('fixture signal error');
  });

  it('attempts every development cleanup and aggregates every failure', async () => {
    const attempts: string[] = [];
    const first = new Error('first cleanup failed');
    const second = new Error('second cleanup failed');

    const results = await Promise.allSettled([
      Promise.resolve().then(() => {
        attempts.push('first');
        throw first;
      }),
      Promise.resolve().then(() => {
        attempts.push('second');
      }),
      Promise.resolve().then(() => {
        attempts.push('control');
        throw second;
      })
    ]);

    expect(attempts).toEqual(['first', 'second', 'control']);
    let error: unknown;
    try {
      throwDevelopmentCleanupFailures(results, 'Fixture development cleanup failed.');
    } catch (failure) {
      error = failure;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([first, second]);
  });
});

function fakeChild(pid: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killedWith: undefined as NodeJS.Signals | undefined,
    kill(signal: NodeJS.Signals) {
      this.killedWith = signal;
      queueMicrotask(() => {
        this.exitCode = 0;
        this.emit('exit', 0, signal);
      });
      return true;
    }
  });
}
