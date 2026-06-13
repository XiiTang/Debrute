import { describe, expect, it, vi } from 'vitest';
import { buildRuntimeTrayMenuTemplate } from '../apps/desktop/src/electron/tray/runtimeTrayMenu';
import { trayIconFileNameForStatus } from '../apps/desktop/src/electron/tray/trayController';

describe('runtime tray menu', () => {
  it('shows runtime state and enables owned actions only when allowed', () => {
    const actions = {
      openDebrute: vi.fn(),
      openRecent: vi.fn(),
      showRuntimeStatus: vi.fn(),
      restartRuntime: vi.fn(),
      quitDebrute: vi.fn()
    };
    const template = buildRuntimeTrayMenuTemplate({
      platform: 'darwin',
      snapshot: {
        status: 'running',
        ownsRuntime: true
      },
      recentProjectRoots: ['/tmp/project-a'],
      actions
    });

    expect(template.map((item) => item.label ?? item.type)).toEqual([
      'Runtime: running',
      'Open Debrute',
      'Open Recent',
      'Runtime Status',
      'Restart Runtime',
      'separator',
      'Quit Debrute'
    ]);
    expect(template.find((item) => item.label === 'Open Debrute')?.enabled).toBe(true);
    expect(template.find((item) => item.label === 'Restart Runtime')?.enabled).toBe(true);
  });

  it('uses Exit Debrute on Windows and disables restart for external runtime', () => {
    const template = buildRuntimeTrayMenuTemplate({
      platform: 'win32',
      snapshot: { status: 'running', ownsRuntime: false },
      recentProjectRoots: [],
      actions: {
        openDebrute: vi.fn(),
        openRecent: vi.fn(),
        showRuntimeStatus: vi.fn(),
        restartRuntime: vi.fn(),
        quitDebrute: vi.fn()
      }
    });

    expect(template.find((item) => item.label === 'Restart Runtime')?.enabled).toBe(false);
    expect(template.at(-1)?.label).toBe('Exit Debrute');
  });

  it('maps every runtime status to a dedicated tray icon asset', () => {
    expect(['starting', 'running', 'degraded', 'stopped', 'error'].map((status) => (
      trayIconFileNameForStatus(status as never)
    ))).toEqual([
      'tray_icon_starting.png',
      'tray_icon_running.png',
      'tray_icon_degraded.png',
      'tray_icon_stopped.png',
      'tray_icon_error.png'
    ]);
  });
});
