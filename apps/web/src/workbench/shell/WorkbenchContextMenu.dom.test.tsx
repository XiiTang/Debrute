import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import {
  PendingWorkbenchContextMenuDismissal,
  WorkbenchContextMenu
} from './WorkbenchContextMenu';

describe('WorkbenchContextMenu lazy items', () => {
  it('focuses the first enabled command when lazy items become ready', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = async (ready: boolean) => {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <WorkbenchContextMenu
              productPlatform="darwin"
              items={ready
                ? [
                    { kind: 'action', command: 'paste', disabled: true },
                    { kind: 'action', command: 'copy' }
                  ]
                : []}
              position={{ x: 12, y: 16 }}
              onCommand={() => undefined}
              onClose={() => undefined}
            />
          </I18nProvider>
        );
      });
    };

    await render(false);
    expect(container.querySelector('button')).toBeNull();
    await render(true);

    const enabled = container.querySelector<HTMLButtonElement>('button:not(:disabled)');
    expect(enabled).not.toBeNull();
    expect(document.activeElement).toBe(enabled);

    await act(async () => root.unmount());
    container.remove();
  });

  it('cancels a pending lazy menu before its command controller mounts', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let closed = 0;
    await act(async () => {
      root.render(
        <PendingWorkbenchContextMenuDismissal onClose={() => { closed += 1; }} />
      );
    });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).toBe(1);

    await act(async () => root.unmount());
    container.remove();
  });
});
