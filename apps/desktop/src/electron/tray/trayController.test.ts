import { describe, expect, it, vi } from 'vitest';
import { buildRuntimeTrayMenuTemplate } from './runtimeTrayMenu.js';
import { TrayController, trayIconFileNameForStatus } from './trayController.js';

describe('runtime tray menu', () => {
  it('shows runtime state and enables owned actions only when allowed', () => {
    const actions = {
      openDebrute: vi.fn(),
      openInElectron: vi.fn(),
      openInBrowser: vi.fn(),
      copyBrowserUrl: vi.fn(),
      openProjectInElectron: vi.fn(),
      openRecentInElectron: vi.fn(),
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
      'Open in Electron',
      'Open in Browser',
      'Copy Browser URL',
      'Open Project in Electron...',
      'Open Recent in Electron',
      'Runtime Status',
      'Restart Runtime',
      'separator',
      'Quit Debrute'
    ]);
    expect(template.find((item) => item.label === 'Open Debrute')?.enabled).toBe(true);
    expect(template.find((item) => item.label === 'Open Project in Electron...')?.enabled).toBe(true);
    expect(template.find((item) => item.label === 'Open Recent in Electron')?.enabled).toBe(true);
    expect(template.find((item) => item.label === 'Restart Runtime')?.enabled).toBe(true);
  });

  it('uses Exit Debrute on Windows and disables restart for external runtime', () => {
    const template = buildRuntimeTrayMenuTemplate({
      platform: 'win32',
      snapshot: { status: 'running', ownsRuntime: false },
      recentProjectRoots: [],
      actions: {
        openDebrute: vi.fn(),
        openInElectron: vi.fn(),
        openInBrowser: vi.fn(),
        copyBrowserUrl: vi.fn(),
        openProjectInElectron: vi.fn(),
        openRecentInElectron: vi.fn(),
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

  it('uses a template tray image on macOS instead of a colored status asset', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const createdImages: FakeNativeImage[] = [];
      const trayInstances: FakeTray[] = [];
      class TestTray extends FakeTray {
        constructor(image: unknown) {
          super(image);
          trayInstances.push(this);
        }
      }
      const controller = new TrayController({
        Tray: TestTray,
        Menu: fakeMenu(),
        nativeImage: {
          createFromPath(path: string) {
            const image = new FakeNativeImage(path);
            createdImages.push(image);
            return image;
          }
        },
        runtimeSupervisor: fakeRuntimeSupervisor('running'),
        readRecentProjectRoots: async () => [],
        onInteraction: () => undefined,
        actions: fakeActions()
      } as never);

      await controller.start();

      expect(createdImages).toHaveLength(2);
      expect(createdImages.map((image) => image.path)).toEqual([
        expect.stringContaining('tray_icon_template@2x.png'),
        expect.stringContaining('tray_icon_template@2x.png')
      ]);
      expect(createdImages.every((image) => image.template)).toBe(true);
      expect(trayInstances[0]?.images).toEqual(createdImages);
      expect(trayInstances[0]?.titles).toEqual(['']);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('refreshes project history surfaces when the tray is opened', async () => {
    const trayInstances: FakeTray[] = [];
    class TestTray extends FakeTray {
      constructor(image: unknown) {
        super(image);
        trayInstances.push(this);
      }
    }
    const onInteraction = vi.fn();
    const controller = new TrayController({
      Tray: TestTray,
      Menu: fakeMenu(),
      nativeImage: { createFromPath: (path: string) => new FakeNativeImage(path) },
      runtimeSupervisor: fakeRuntimeSupervisor('running'),
      readRecentProjectRoots: async () => [],
      onInteraction,
      actions: fakeActions()
    } as never);

    await controller.start();
    trayInstances[0]?.emit('click');
    trayInstances[0]?.emit('right-click');
    await Promise.resolve();

    expect(onInteraction).toHaveBeenCalledTimes(2);
  });
});

class FakeNativeImage {
  template = false;

  constructor(readonly path: string) {}

  setTemplateImage(template: boolean): void {
    this.template = template;
  }
}

class FakeTray {
  images: unknown[];
  titles: string[] = [];
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(image: unknown) {
    this.images = [image];
  }

  setImage(image: unknown): void {
    this.images.push(image);
  }

  setToolTip(): void {}

  setTitle(title: string): void {
    this.titles.push(title);
  }

  setContextMenu(): void {}

  on(event: string, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }

  destroy(): void {}
}

function fakeMenu() {
  return {
    buildFromTemplate(template: unknown) {
      return template;
    }
  };
}

function fakeRuntimeSupervisor(status: 'running') {
  return {
    snapshot: () => ({ status, ownsRuntime: true }),
    on: vi.fn()
  };
}

function fakeActions() {
  return {
    openDebrute: vi.fn(),
    openInElectron: vi.fn(),
    openInBrowser: vi.fn(),
    copyBrowserUrl: vi.fn(),
    openProjectInElectron: vi.fn(),
    openRecentInElectron: vi.fn(),
    showRuntimeStatus: vi.fn(),
    restartRuntime: vi.fn(),
    quitDebrute: vi.fn()
  };
}
