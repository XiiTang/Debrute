import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/index';
import {
  PendingWorkbenchContextMenuDismissal,
  WorkbenchContextMenu
} from './WorkbenchContextMenu';

describe('WorkbenchContextMenu lazy items', () => {
  it('labels recoverable and permanent deletion distinctly and pluralizes path copy', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <WorkbenchContextMenu
            productPlatform="darwin"
            items={[
              { kind: 'action', command: 'copy-path' },
              { kind: 'action', command: 'delete' },
              { kind: 'action', command: 'delete-permanently' }
            ]}
            selectionCount={2}
            position={{ x: 12, y: 16 }}
            onCommand={() => undefined}
            onClose={() => undefined}
            onReturnFocus={() => undefined}
          />
        </I18nProvider>
      );
    });

    expect(container.textContent).toContain('Copy Paths');
    expect(container.textContent).toContain('Move to Trash');
    expect(container.textContent).toContain('Delete Permanently');

    await act(async () => root.unmount());
    container.remove();
  });

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
              onReturnFocus={() => undefined}
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

  it('opens the Photoshop submenu by keyboard and preserves duplicate Document titles', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <WorkbenchContextMenu
            productPlatform="darwin"
            items={[{
              kind: 'photoshop-submenu',
              command: 'send-to-photoshop',
              targets: [
                { pluginSessionId: 'session-1', documentId: 7, title: 'Poster.psd' },
                { pluginSessionId: 'session-2', documentId: 9, title: 'Poster.psd' }
              ]
            }]}
            position={{ x: 12, y: 16 }}
            onCommand={() => undefined}
            onClose={() => undefined}
            onReturnFocus={() => undefined}
          />
        </I18nProvider>
      );
    });

    const trigger = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Send to Photoshop')
    );
    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    const documentButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .filter((button) => button.textContent === 'Poster.psd');
    expect(documentButtons).toHaveLength(2);
    expect(document.activeElement).toBe(documentButtons[0]);

    await act(async () => root.unmount());
    container.remove();
  });

  it('shows the AVIF host requirement on a disabled Document and focuses a compatible target', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onCommand = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider locale="zh-CN">
          <WorkbenchContextMenu
            productPlatform="darwin"
            items={[{
              kind: 'photoshop-submenu',
              command: 'send-to-photoshop',
              targets: [
                {
                  pluginSessionId: 'session-1',
                  documentId: 7,
                  title: 'PngOnly.psd',
                  disabled: true,
                  requirement: 'photoshop_26_8_for_avif'
                },
                { pluginSessionId: 'session-2', documentId: 9, title: 'AvifCapable.psd' }
              ]
            }]}
            position={{ x: 12, y: 16 }}
            onCommand={onCommand}
            onClose={() => undefined}
            onReturnFocus={() => undefined}
          />
        </I18nProvider>
      );
    });

    const trigger = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('发送到 Photoshop')
    );
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    const pngOnly = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('PngOnly.psd')
    );
    const avifCapable = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('AvifCapable.psd')
    );
    expect(pngOnly?.disabled).toBe(true);
    expect(pngOnly?.textContent).toContain('ps ≥26.8 以支持 AVIF');
    expect(document.activeElement).toBe(avifCapable);

    await act(async () => {
      pngOnly?.click();
      avifCapable?.click();
    });
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith('send-to-photoshop', {
      pluginSessionId: 'session-2',
      documentId: 9,
      title: 'AvifCapable.psd'
    });

    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps an all-incompatible AVIF submenu visible without moving focus to a disabled target', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onCommand = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider locale="zh-CN">
          <WorkbenchContextMenu
            productPlatform="darwin"
            items={[{
              kind: 'photoshop-submenu',
              command: 'send-to-photoshop',
              targets: [
                {
                  pluginSessionId: 'session-1',
                  documentId: 7,
                  title: 'Poster.psd',
                  disabled: true,
                  requirement: 'photoshop_26_8_for_avif'
                },
                {
                  pluginSessionId: 'session-1',
                  documentId: 9,
                  title: 'Reference.psd',
                  disabled: true,
                  requirement: 'photoshop_26_8_for_avif'
                }
              ]
            }]}
            position={{ x: 12, y: 16 }}
            onCommand={onCommand}
            onClose={() => undefined}
            onReturnFocus={() => undefined}
          />
        </I18nProvider>
      );
    });

    const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('发送到 Photoshop')
    );
    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    const targets = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .filter((button) => button.textContent?.includes('ps ≥26.8 以支持 AVIF'));
    expect(targets).toHaveLength(2);
    expect(targets.every((button) => button.disabled)).toBe(true);
    expect(document.activeElement).toBe(trigger);
    targets.forEach((button) => button.click());
    expect(onCommand).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    container.remove();
  });

  it('returns borrowed focus when its owner removes the menu', async () => {
    const source = document.createElement('button');
    const container = document.createElement('div');
    document.body.append(source, container);
    const root = createRoot(container);

    await act(async () => root.render(
      <I18nProvider locale="en">
        <WorkbenchContextMenu
          productPlatform="darwin"
          items={[{ kind: 'action', command: 'copy' }]}
          position={{ x: 12, y: 16 }}
          onCommand={() => undefined}
          onClose={() => undefined}
          onReturnFocus={() => source.focus()}
        />
      </I18nProvider>
    ));
    expect(document.activeElement).toBe(container.querySelector('button'));

    await act(async () => root.render(null));

    expect(document.activeElement).toBe(source);

    await act(async () => root.unmount());
    source.remove();
    container.remove();
  });
});
