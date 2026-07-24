import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildWorkbenchTitleBarState } from './workbenchTitleBarState';
import { WorkbenchTitleBar } from './WorkbenchTitleBar';
import { I18nProvider } from '../i18n';

describe('WorkbenchTitleBar', () => {
  it('hides Web menus and window controls on macOS Desktop', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <WorkbenchTitleBar
          state={buildWorkbenchTitleBarState({
            platform: 'darwin',
            host: 'desktop', locale: 'en',
            projectTitle: 'Alpha',
            recentProjectRoots: ['/tmp/alpha']
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
  });

  it('renders Web menus and window controls on Windows Desktop', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <WorkbenchTitleBar
          state={buildWorkbenchTitleBarState({
            platform: 'win32',
            host: 'desktop', locale: 'en',
            projectTitle: 'Beta',
            recentProjectRoots: ['/tmp/beta']
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
    expect(html).toMatch(/aria-label="Close window"[^>]*db-icon-button--window-close/);
    expect(html).toContain('-webkit-app-region:drag');
    expect(html).toContain('-webkit-app-region:no-drag');
  });

  it('disables only maximize while native window state is unavailable', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <WorkbenchTitleBar
          state={buildWorkbenchTitleBarState({
            platform: 'win32',
            host: 'desktop', locale: 'en',
            projectTitle: 'Beta',
            recentProjectRoots: []
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
          state={buildWorkbenchTitleBarState({
            platform: 'win32',
            host: 'web', locale: 'en',
            projectTitle: undefined,
            recentProjectRoots: []
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
              state={buildWorkbenchTitleBarState({
                platform: 'win32',
                host: 'web', locale: 'en',
                projectTitle: 'Alpha',
                recentProjectRoots: ['/tmp/alpha']
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
        payload: { projectRoot: '/tmp/alpha' }
      }));
      expect(fileButton.getAttribute('aria-expanded')).toBe('false');
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
