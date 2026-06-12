import { describe, expect, it } from 'vitest';
import { runProjectWindowOpenOnce, selectProjectWindowOpenTarget } from './windowProjectRouting';

describe('selectProjectWindowOpenTarget', () => {
  it('focuses an existing project window even when another window triggered open', () => {
    expect(selectProjectWindowOpenTarget({
      projectId: 'project-a',
      sourceWindowId: 2,
      forceNewWindow: false,
      windowIdByProjectId: new Map([['project-a', 1]]),
      liveWindowIds: new Set([1, 2])
    })).toEqual({ kind: 'focus', windowId: 1 });
  });

  it('reuses the source window for normal open when the target project has no Electron window', () => {
    expect(selectProjectWindowOpenTarget({
      projectId: 'project-b',
      sourceWindowId: 2,
      forceNewWindow: false,
      windowIdByProjectId: new Map([['project-a', 2]]),
      liveWindowIds: new Set([2])
    })).toEqual({ kind: 'reuse', windowId: 2 });
  });

  it('creates a new window for explicit new-window open when the target project is not open', () => {
    expect(selectProjectWindowOpenTarget({
      projectId: 'project-b',
      sourceWindowId: 2,
      forceNewWindow: true,
      windowIdByProjectId: new Map([['project-a', 2]]),
      liveWindowIds: new Set([2])
    })).toEqual({ kind: 'new-window' });
  });

  it('creates a new window when no source window exists', () => {
    expect(selectProjectWindowOpenTarget({
      projectId: 'project-b',
      forceNewWindow: false,
      windowIdByProjectId: new Map(),
      liveWindowIds: new Set()
    })).toEqual({ kind: 'new-window' });
  });

  it('coalesces concurrent opens for the same project while the first window is still loading', async () => {
    const pendingProjectOpens = new Map<string, Promise<void>>();
    const releaseFirstOpen = deferred<void>();
    let openCount = 0;
    let reusePendingCount = 0;

    const first = runProjectWindowOpenOnce({
      projectId: 'project-a',
      pendingProjectOpens,
      open: async () => {
        openCount += 1;
        await releaseFirstOpen.promise;
      },
      reusePending: () => {
        reusePendingCount += 1;
      }
    });
    const second = runProjectWindowOpenOnce({
      projectId: 'project-a',
      pendingProjectOpens,
      open: async () => {
        openCount += 1;
      },
      reusePending: () => {
        reusePendingCount += 1;
      }
    });

    await Promise.resolve();
    expect(openCount).toBe(1);
    expect(reusePendingCount).toBe(0);

    releaseFirstOpen.resolve();
    await Promise.all([first, second]);
    expect(reusePendingCount).toBe(1);
    expect(pendingProjectOpens.has('project-a')).toBe(false);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
