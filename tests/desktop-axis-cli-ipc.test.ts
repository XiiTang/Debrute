import { describe, expect, it } from 'vitest';
import { createSafeIpcHandler } from '../apps/desktop/src/electron/ipc/ipcErrors';
import { registerWorkbenchIpc } from '../apps/desktop/src/electron/ipc/registerWorkbenchIpc';

describe('Axis CLI IPC', () => {
  it('registers fixed argument-free CLI operation channels', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const ipcMain = {
      handle: (channel: string, handler: (_event: unknown, ...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, (...args: unknown[]) => handler({}, ...args));
      }
    };
    const axisCliManager = {
      getStatus: async () => ({ mode: 'missing', managed: false, updateAvailable: false, commandPath: '/h/.axis/bin/axis', binDir: '/h/.axis/bin', installRoot: '/h/.axis/cli', pathState: 'not-configured' }),
      install: async () => ({ mode: 'release', managed: true, updateAvailable: false, commandPath: '/h/.axis/bin/axis', binDir: '/h/.axis/bin', installRoot: '/h/.axis/cli', pathState: 'configured' }),
      update: async () => ({ mode: 'release', managed: true, updateAvailable: false, commandPath: '/h/.axis/bin/axis', binDir: '/h/.axis/bin', installRoot: '/h/.axis/cli', pathState: 'configured' }),
      repair: async () => ({ mode: 'release', managed: true, updateAvailable: false, commandPath: '/h/.axis/bin/axis', binDir: '/h/.axis/bin', installRoot: '/h/.axis/cli', pathState: 'configured' }),
      uninstall: async () => ({ mode: 'missing', managed: false, updateAvailable: false, commandPath: '/h/.axis/bin/axis', binDir: '/h/.axis/bin', installRoot: '/h/.axis/cli', pathState: 'not-configured' }),
      refreshDevelopmentLink: async () => ({ mode: 'source-linked', managed: true, updateAvailable: false, commandPath: '/h/.axis/bin/axis', binDir: '/h/.axis/bin', installRoot: '/h/.axis/cli', pathState: 'configured' })
    };

    registerWorkbenchIpc({
      ipcMain: ipcMain as never,
      dialog: {} as never,
      shell: {} as never,
      server: {} as never,
      platform: 'darwin',
      axisCliManager: () => axisCliManager,
      readDesktopState: async () => ({ recentProjectRoots: [], setupCompleted: false }),
      setSetupCompleted: async (completed) => ({ recentProjectRoots: [], setupCompleted: completed }),
      chooseProjectRoot: async () => undefined,
      rememberProjectRoot: async () => undefined,
      updateService: () => ({} as never),
      hotExitStore: () => ({} as never)
    });

    expect([...handlers.keys()]).toContain('axis:axisCliInstall');
    expect(await handlers.get('axis:axisCliInstall')?.({ url: 'https://example.invalid' })).toEqual({
      ok: true,
      value: expect.objectContaining({ mode: 'release' })
    });
  });

  it('wraps operation errors without leaking stack traces', async () => {
    const handler = createSafeIpcHandler(async () => {
      throw Object.assign(new Error('release not found'), { code: 'release_not_found' });
    });

    expect(await handler()).toEqual({
      ok: false,
      error: { code: 'release_not_found', message: 'release not found' }
    });
  });
});
