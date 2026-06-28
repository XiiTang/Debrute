import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildWorkbenchTitleBarState } from '@debrute/app-protocol';
import { WorkbenchTitleBar } from './WorkbenchTitleBar';
import { I18nProvider } from '../i18n';

describe('WorkbenchTitleBar', () => {
  it('hides Web menus and window controls on macOS Desktop', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <WorkbenchTitleBar
          state={buildWorkbenchTitleBarState({
            platform: 'darwin',
            host: 'desktop',
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
            host: 'desktop',
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
    expect(html).toContain('-webkit-app-region:drag');
    expect(html).toContain('-webkit-app-region:no-drag');
  });

  it('renders Web menus without native controls in browser host', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <WorkbenchTitleBar
          state={buildWorkbenchTitleBarState({
            platform: 'linux',
            host: 'web',
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

  it('renders submenu items as interactive submenu triggers instead of disabled expanded groups', () => {
    const source = readFileSync('apps/web/src/workbench/shell/WorkbenchTitleBar.tsx', 'utf8');

    expect(source).toContain('workbench-titlebar__submenu-trigger');
    expect(source).toContain('aria-haspopup="menu"');
    expect(source).toContain('aria-controls={submenuId}');
    expect(source).toContain('menuRef.current?.querySelector<HTMLButtonElement>');
    expect(source).toContain('restoreMenuButtonFocus');
    expect(source).not.toContain('role="group"');
    expect(source).not.toContain('<Menu.Item disabled>{item.label}</Menu.Item>');
  });

  it('fades the title-bar material before the bottom edge', () => {
    const source = readFileSync('apps/web/src/workbench/styles/titlebar.css', 'utf8');

    expect(source).toContain('.workbench-titlebar::before');
    expect(source).toContain('transparent 86%');
    expect(source).toContain('transparent 100%');
    expect(source).not.toContain('inset 0 -1px 0');
  });
});
