import { describe, expect, it, vi } from 'vitest';
import { loadDebruteProjectShellWindow, waitForDebruteShellUrl } from './desktopShellLoad';

describe('desktop shell loading', () => {
  it('waits until the workbench URL is reachable before Electron loads it', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('not ready'))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const sleeps: number[] = [];

    await waitForDebruteShellUrl('http://127.0.0.1:17322/projects/project-1', {
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: sequenceNow([0, 100, 200])
    }, {
      timeoutMs: 1000,
      intervalMs: 25
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([25]);
  });

  it('fails clearly when the workbench URL never becomes reachable', async () => {
    await expect(waitForDebruteShellUrl('http://127.0.0.1:17322/', {
      fetch: async () => new Response('', { status: 503 }),
      sleep: async () => undefined,
      now: sequenceNow([0, 100, 200, 300])
    }, {
      timeoutMs: 250,
      intervalMs: 10
    })).rejects.toThrow('Debrute workbench URL did not become reachable: http://127.0.0.1:17322/');
  });

  it('binds project windows before probing and loading the project URL', async () => {
    const events: string[] = [];

    await loadDebruteProjectShellWindow({
      loadURL: async () => {
        events.push('loadURL');
      }
    }, 'http://127.0.0.1:17322/projects/project-1', () => {
      events.push('bind');
    }, {
      fetch: async () => {
        events.push('probe');
        return new Response('', { status: 200 });
      },
      sleep: async () => undefined,
      now: sequenceNow([0])
    }, {
      timeoutMs: 1000,
      intervalMs: 25
    });

    expect(events).toEqual(['bind', 'probe', 'loadURL']);
  });

  it('does not load project windows when binding fails', async () => {
    const loadURL = vi.fn();

    await expect(loadDebruteProjectShellWindow({
      loadURL
    }, 'http://127.0.0.1:17322/projects/project-1', () => {
      throw new Error('lease failed');
    }, {
      fetch: async () => new Response('', { status: 200 }),
      sleep: async () => undefined,
      now: sequenceNow([0])
    }, {
      timeoutMs: 1000,
      intervalMs: 25
    })).rejects.toThrow('lease failed');

    expect(loadURL).not.toHaveBeenCalled();
  });

  it('keeps the project window lease when Electron navigation fails', async () => {
    const bindProjectWindow = vi.fn();

    await expect(loadDebruteProjectShellWindow({
      loadURL: async () => {
        throw new Error('navigation failed');
      }
    }, 'http://127.0.0.1:17322/projects/project-1', bindProjectWindow, {
      fetch: async () => new Response('', { status: 200 }),
      sleep: async () => undefined,
      now: sequenceNow([0])
    }, {
      timeoutMs: 1000,
      intervalMs: 25
    })).rejects.toThrow('navigation failed');

    expect(bindProjectWindow).toHaveBeenCalledTimes(1);
  });

  it('waits for asynchronous project window binding before resolving', async () => {
    let finishBind!: () => void;
    const bindFinished = new Promise<void>((resolve) => {
      finishBind = resolve;
    });
    let resolved = false;

    const load = loadDebruteProjectShellWindow({
      loadURL: async () => undefined
    }, 'http://127.0.0.1:17322/projects/project-1', async () => {
      await bindFinished;
    }, {
      fetch: async () => new Response('', { status: 200 }),
      sleep: async () => undefined,
      now: sequenceNow([0])
    }, {
      timeoutMs: 1000,
      intervalMs: 25
    }).then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);

    finishBind();
    await load;
    expect(resolved).toBe(true);
  });

  it('fails when asynchronous project window binding fails', async () => {
    await expect(loadDebruteProjectShellWindow({
      loadURL: async () => undefined
    }, 'http://127.0.0.1:17322/projects/project-1', async () => {
      await Promise.resolve();
      throw new Error('lease failed');
    }, {
      fetch: async () => new Response('', { status: 200 }),
      sleep: async () => undefined,
      now: sequenceNow([0])
    }, {
      timeoutMs: 1000,
      intervalMs: 25
    })).rejects.toThrow('lease failed');
  });
});

function sequenceNow(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
