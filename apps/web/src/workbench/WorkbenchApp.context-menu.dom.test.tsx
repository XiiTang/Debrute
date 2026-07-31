import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from './i18n/index.js';
import type { ProjectPathCommandRouter } from './services/projectPathCommandRouter.js';
import { ProjectPathContextMenuHost } from './WorkbenchApp.js';

describe('ProjectPathContextMenuHost', () => {
  it('builds items directly from the closed project-path target', async () => {
    const contextMenuItems = vi.fn(() => [{
      kind: 'action' as const,
      command: 'copy' as const
    }]);
    const router = { contextMenuItems, run: vi.fn() } satisfies ProjectPathCommandRouter;
    const target = {
      source: 'explorer' as const,
      invocationEntry: { projectRelativePath: 'brief.md', kind: 'file' as const },
      selectedEntries: [{ projectRelativePath: 'brief.md', kind: 'file' as const }]
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(
      <I18nProvider locale="en">
        <ProjectPathContextMenuHost
          contextMenu={{ target, position: { x: 12, y: 16 } }}
          router={router}
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
});
