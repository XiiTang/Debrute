import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from './i18n/index';
import type { ProjectPathCommandRouter } from './services/projectPathCommandRouter';
import { createWorkbenchFocusCommandRouter } from './services/workbenchFocusCommandRouter';
import { ProjectPathContextMenuHost } from './WorkbenchApp';

describe('ProjectPathContextMenuHost', () => {
  it('builds items directly from the closed project-path target', async () => {
    const contextMenuItems = vi.fn(() => [{
      kind: 'action' as const,
      command: 'copy' as const
    }]);
    const router = { contextMenuItems, run: vi.fn() } satisfies ProjectPathCommandRouter;
    const target = {
      source: 'explorer' as const,
      invocation: { projectRelativePath: 'brief.md', kind: 'file' as const },
      selection: [{ projectRelativePath: 'brief.md', kind: 'file' as const }]
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(
      <I18nProvider locale="en">
        <ProjectPathContextMenuHost
          contextMenu={{ target, position: { x: 12, y: 16 } }}
          router={router}
          focusRouter={{ restoreOwnerFocus: vi.fn() }}
          productPlatform="darwin"
          onClose={() => undefined}
        />
      </I18nProvider>
    ));
    expect(contextMenuItems).toHaveBeenCalledWith(target);
    expect(container.querySelector('button')?.textContent).toContain('Copy');

    await act(async () => root.unmount());
    container.remove();
  });

  it('returns menu focus to its source without stealing a newer focus destination', async () => {
    const router = {
      contextMenuItems: vi.fn(() => [{ kind: 'action' as const, command: 'copy' as const }]),
      run: vi.fn()
    } satisfies ProjectPathCommandRouter;
    const explorer = document.createElement('div');
    explorer.tabIndex = 0;
    const canvas = document.createElement('div');
    canvas.tabIndex = 0;
    const newerDestination = document.createElement('button');
    document.body.append(explorer, canvas, newerDestination);
    const focusRouter = createWorkbenchFocusCommandRouter({
      getRuntime: () => undefined,
      getProjection: () => undefined,
      getCanvasRoot: () => canvas,
      getExplorerRoot: () => explorer,
      getProjectPathRouter: () => undefined,
      getExplorerController: () => undefined
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const escapedMenuKey = vi.fn();
    window.addEventListener('keydown', escapedMenuKey);
    const renderMenu = async (source: 'canvas' | 'explorer') => {
      await act(async () => root.render(
        <I18nProvider locale="en">
          <ProjectPathContextMenuHost
            contextMenu={{
              target: {
                source,
                invocation: { projectRelativePath: 'brief.md', kind: 'file' },
                selection: [{ projectRelativePath: 'brief.md', kind: 'file' }]
              },
              position: { x: 12, y: 16 }
            }}
            router={router}
            focusRouter={focusRouter}
            productPlatform="darwin"
            onClose={() => undefined}
          />
        </I18nProvider>
      ));
    };

    await renderMenu('explorer');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.activeElement).toBe(explorer);
    expect(escapedMenuKey).not.toHaveBeenCalled();

    await renderMenu('canvas');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.activeElement).toBe(canvas);

    await renderMenu('explorer');
    router.run.mockImplementationOnce(() => newerDestination.focus());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
    });
    expect(document.activeElement).toBe(newerDestination);

    await act(async () => root.unmount());
    window.removeEventListener('keydown', escapedMenuKey);
    container.remove();
    explorer.remove();
    canvas.remove();
    newerDestination.remove();
  });
});
