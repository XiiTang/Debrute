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

  it('binds project windows only after Electron loads the project URL', async () => {
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

    expect(events).toEqual(['probe', 'loadURL', 'bind']);
  });

  it('keeps project windows unbound when Electron navigation fails', async () => {
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

    expect(bindProjectWindow).not.toHaveBeenCalled();
  });
});

function sequenceNow(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
