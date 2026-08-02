import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildWorkbenchTitleBarState } from './workbenchTitleBarState';
import { WorkbenchTitleBar } from './WorkbenchTitleBar';
import { I18nProvider } from '../i18n';

const closedActivityProps = {
  activityCenterOpen: false,
  activityBellRef: createRef<HTMLButtonElement>(),
  onToggleActivityCenter: () => undefined,
  onCloseActivityCenter: () => undefined
};

describe('WorkbenchTitleBar', () => {
  it('hides Web menus and window controls on macOS Desktop', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <WorkbenchTitleBar
          {...closedActivityProps}
          state={buildWorkbenchTitleBarState({
            platform: 'darwin',
            host: 'desktop', locale: 'en',
            projectTitle: 'Alpha',
            recentProjects: [{ projectId: 'alpha', projectRoot: '/tmp/alpha' }]
          })}
          nativeWindowState={{ maximized: false }}
          onCommand={() => undefined}
          onWindowCommand={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('Alpha');
    expect(html).toContain('workbench-titlebar--traffic-spacer');
    expect(html).not.toContain('>File<');
    expect(html).not.toContain('Minimize window');
    expect(html).toContain('aria-label="Activity"');
  });

  it('renders Web menus and window controls on Windows Desktop', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <WorkbenchTitleBar
          {...closedActivityProps}
          state={buildWorkbenchTitleBarState({
            platform: 'win32',
            host: 'desktop', locale: 'en',
            projectTitle: 'Beta',
            recentProjects: [{ projectId: 'beta', projectRoot: '/tmp/beta' }]
          })}
          nativeWindowState={{ maximized: true }}
          onCommand={() => undefined}
          onWindowCommand={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('>File<');
    expect(html).toContain('>Edit<');
    expect(html).toContain('>View<');
    expect(html).toContain('aria-controls="workbench-titlebar-menu-file"');
    expect(html).toContain('Restore window');
    expect(html).toContain('Close window');
    expect(html.match(/db-icon-button--window(?:\s|")/g) ?? []).toHaveLength(3);
    expect(html.match(/db-icon-button--titlebar(?:\s|")/g) ?? []).toHaveLength(3);
    expect(html).toMatch(/aria-label="Close window"[^>]*db-icon-button--window-close/);
    expect(html).toContain('-webkit-app-region:drag');
    expect(html).toContain('-webkit-app-region:no-drag');
  });

  it('disables only maximize while native window state is unavailable', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <WorkbenchTitleBar
          {...closedActivityProps}
          state={buildWorkbenchTitleBarState({
            platform: 'win32',
            host: 'desktop', locale: 'en',
            projectTitle: 'Beta',
            recentProjects: []
          })}
          nativeWindowState={undefined}
          onCommand={() => undefined}
          onWindowCommand={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toMatch(/aria-label="Minimize window"(?![^>]*disabled)/);
    expect(html).toMatch(/<button disabled=""[^>]*aria-label="Maximize window"/);
    expect(html).toMatch(/aria-label="Close window"(?![^>]*disabled)/);
  });

  it('renders Web menus without native controls in browser host', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <WorkbenchTitleBar
          {...closedActivityProps}
          state={buildWorkbenchTitleBarState({
            platform: 'win32',
            host: 'web', locale: 'en',
            projectTitle: undefined,
            recentProjects: []
          })}
          nativeWindowState={{ maximized: false }}
          onCommand={() => undefined}
          onWindowCommand={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('Debrute');
    expect(html).toContain('>File<');
    expect(html).not.toContain('Close window');
  });

  it('opens and selects recent-project submenu items through accessible menu controls', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onCommand = vi.fn();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <WorkbenchTitleBar
              {...closedActivityProps}
              state={buildWorkbenchTitleBarState({
                platform: 'win32',
                host: 'web', locale: 'en',
                projectTitle: 'Alpha',
                recentProjects: [{ projectId: 'alpha', projectRoot: '/tmp/alpha' }]
              })}
              nativeWindowState={{ maximized: false }}
              onCommand={onCommand}
              onWindowCommand={() => undefined}
            />
          </I18nProvider>
        );
      });

      const fileButton = requireButton(container, 'File');
      expect(fileButton.getAttribute('aria-haspopup')).toBe('menu');
      expect(fileButton.getAttribute('aria-expanded')).toBe('false');
      expect(fileButton.getAttribute('aria-controls')).toBe('workbench-titlebar-menu-file');

      await act(async () => {
        fileButton.click();
      });

      const titleBar = container.querySelector('.workbench-titlebar');
      const menuPopover = container.querySelector('.workbench-titlebar__menu-popover');
      expect(menuPopover).not.toBeNull();
      expect(titleBar?.contains(menuPopover)).toBe(false);

      const recentTrigger = requireButton(container, 'Open Recent');
      expect(recentTrigger.getAttribute('role')).toBe('menuitem');
      expect(recentTrigger.getAttribute('aria-haspopup')).toBe('menu');
      expect(recentTrigger.getAttribute('aria-expanded')).toBe('false');
      expect(recentTrigger.getAttribute('aria-controls')).toBe('workbench-titlebar-submenu-project.open-recent');

      await act(async () => {
        recentTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      });

      const submenuId = recentTrigger.getAttribute('aria-controls');
      const submenu = submenuId ? document.getElementById(submenuId) : null;
      expect(recentTrigger.getAttribute('aria-expanded')).toBe('true');
      expect(submenu?.getAttribute('role')).toBe('menu');
      expect(requireButton(container, '/tmp/alpha').getAttribute('role')).toBe('menuitem');

      await act(async () => {
        submenu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      });
      expect(recentTrigger.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(recentTrigger);

      await act(async () => {
        recentTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      });

      await act(async () => {
        requireButton(container, '/tmp/alpha').click();
      });
      expect(onCommand).toHaveBeenCalledOnce();
      expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
        commandId: 'project.open-recent',
        payload: { projectId: 'alpha', projectRoot: '/tmp/alpha' }
      }));
      expect(fileButton.getAttribute('aria-expanded')).toBe('false');
    } finally {
      await unmount(root, container);
    }
  });

  it('keeps the original content behavior owner while switching into the Edit menu', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onCommand = vi.fn();
    const onCaptureBehaviorOwner = vi.fn(() => 'canvas' as const);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <WorkbenchTitleBar
              {...closedActivityProps}
              state={buildWorkbenchTitleBarState({
                platform: 'win32',
                host: 'web',
                locale: 'en',
                recentProjects: []
              })}
              nativeWindowState={undefined}
              onCommand={onCommand}
              onCaptureBehaviorOwner={onCaptureBehaviorOwner}
              onWindowCommand={() => undefined}
            />
          </I18nProvider>
        );
      });

      const fileButton = requireButton(container, 'File');
      const editButton = requireButton(container, 'Edit');
      await act(async () => {
        fileButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        fileButton.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      });
      await act(async () => {
        editButton.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      await act(async () => {
        requireButton(container, 'Copy').click();
      });

      expect(onCaptureBehaviorOwner).toHaveBeenCalledOnce();
      expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'edit.copy' }), 'canvas');
    } finally {
      await unmount(root, container);
    }
  });

  it('keeps the Activity Center and application menus mutually exclusive', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onCloseActivityCenter = vi.fn();
    const onToggleActivityCenter = vi.fn();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <WorkbenchTitleBar
              {...closedActivityProps}
              activityCenterOpen
              state={buildWorkbenchTitleBarState({
                platform: 'win32',
                host: 'web',
                locale: 'en',
                recentProjects: []
              })}
              nativeWindowState={undefined}
              onCommand={() => undefined}
              onCloseActivityCenter={onCloseActivityCenter}
              onToggleActivityCenter={onToggleActivityCenter}
              onWindowCommand={() => undefined}
            />
          </I18nProvider>
        );
      });

      const fileButton = requireButton(container, 'File');
      await act(async () => fileButton.click());
      expect(onCloseActivityCenter).toHaveBeenCalledOnce();
      expect(fileButton.getAttribute('aria-expanded')).toBe('true');

      const bell = container.querySelector<HTMLButtonElement>('[data-workbench-activity-bell]');
      await act(async () => bell?.click());
      expect(fileButton.getAttribute('aria-expanded')).toBe('false');
      expect(onToggleActivityCenter).toHaveBeenCalledOnce();
    } finally {
      await unmount(root, container);
    }
  });

  it('installs an available Product update directly from the title bar', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onInstallProductUpdate = vi.fn();
    const onToggleActivityCenter = vi.fn();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <WorkbenchTitleBar
              {...closedActivityProps}
              state={buildWorkbenchTitleBarState({
                platform: 'darwin',
                host: 'desktop', locale: 'en',
                projectTitle: 'Alpha',
                recentProjects: []
              })}
              nativeWindowState={{ maximized: false }}
              updateVersion="1.2.3"
              onCommand={() => undefined}
              onInstallProductUpdate={onInstallProductUpdate}
              onToggleActivityCenter={onToggleActivityCenter}
              onWindowCommand={() => undefined}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        requireButton(container, 'Update 1.2.3').click();
      });
      expect(onInstallProductUpdate).toHaveBeenCalledOnce();

      const buttons = Array.from(container.querySelectorAll('button'));
      const updateIndex = buttons.findIndex((button) => button.textContent === 'Update 1.2.3');
      const activityIndex = buttons.findIndex((button) => button.getAttribute('aria-label') === 'Activity');
      expect(updateIndex).toBeLessThan(activityIndex);

      await act(async () => {
        buttons[activityIndex]?.click();
      });
      expect(onToggleActivityCenter).toHaveBeenCalledOnce();
    } finally {
      await unmount(root, container);
    }
  });
});

function requireButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent === label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button ${label}.`);
  }
  return button;
}


async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}
