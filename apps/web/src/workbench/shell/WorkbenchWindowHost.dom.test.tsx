import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/index.js';
import { saveProjectViewState } from '../services/projectViewState.js';
import {
  WorkbenchWindowHost,
  useWorkbenchWindow,
  type WorkbenchWindowHostHandle
} from './WorkbenchWindowHost.js';
import {
  DEFAULT_FLOATING_PANEL_STATE,
  type FloatingPanelId
} from './floatingPanels.js';
import { textEditorWindowIdentity } from './workbenchWindowOrder.js';

describe('WorkbenchWindowHost', () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('restores project panels, activates their features, and owns separate dock and window layers', async () => {
    saveProjectViewState({
      storage: window.sessionStorage,
      canonicalRoot: 'project-window-host',
      state: {
        floatingPanels: {
          panels: {
            ...DEFAULT_FLOATING_PANEL_STATE.panels,
            settings: { ...DEFAULT_FLOATING_PANEL_STATE.panels.settings, open: true }
          }
        }
      }
    });
    const onPanelIntent = vi.fn();
    const rendered = await renderHost({ onPanelIntent });

    expect(rendered.container.querySelector('[data-testid="workbench-dock-layer"]')).not.toBeNull();
    const windowLayer = rendered.container.querySelector('[data-testid="workbench-window-layer"]');
    expect(windowLayer?.querySelector('[data-testid="floating-panel-settings"]')).not.toBeNull();
    expect(windowLayer?.textContent).toContain('settings content');
    expect(onPanelIntent).toHaveBeenCalledWith('settings');

    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });

  it('opens available panels through its public command and rejects disabled panels', async () => {
    saveProjectViewState({
      storage: window.sessionStorage,
      canonicalRoot: 'project-window-host',
      state: {
        floatingPanels: {
          panels: {
            ...DEFAULT_FLOATING_PANEL_STATE.panels,
            terminal: { ...DEFAULT_FLOATING_PANEL_STATE.panels.terminal, open: true }
          }
        }
      }
    });
    const hostRef = React.createRef<WorkbenchWindowHostHandle>();
    const onPanelIntent = vi.fn();
    const rendered = await renderHost({ hostRef, onPanelIntent, disabledPanelIds: ['terminal'] });

    await act(async () => {
      hostRef.current?.openPanel('explorer');
      hostRef.current?.openPanel('terminal');
    });

    expect(rendered.container.querySelector('[data-testid="floating-panel-explorer"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="floating-panel-terminal"]')).toBeNull();
    expect(onPanelIntent).toHaveBeenCalledWith('explorer');
    expect(onPanelIntent).not.toHaveBeenCalledWith('terminal');

    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });

  it('orders panels and floating text editors inside one Workbench window layer', async () => {
    saveProjectViewState({
      storage: window.sessionStorage,
      canonicalRoot: 'project-window-host',
      state: {
        floatingPanels: {
          panels: {
            ...DEFAULT_FLOATING_PANEL_STATE.panels,
            settings: { ...DEFAULT_FLOATING_PANEL_STATE.panels.settings, open: true }
          }
        }
      }
    });
    const rendered = await renderHost({
      onPanelIntent: () => undefined,
      children: <RegisteredTextWindow />
    });
    const panel = rendered.container.querySelector<HTMLElement>('[data-testid="floating-panel-settings"]')!;
    const textWindow = rendered.container.querySelector<HTMLElement>('[data-testid="registered-text-window"]')!;

    expect(panel.parentElement).toBe(textWindow.parentElement);
    expect(Number(textWindow.style.zIndex)).toBeGreaterThan(Number(panel.style.zIndex));

    await act(async () => {
      panel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 41 }));
    });

    expect(Number(panel.style.zIndex)).toBeGreaterThan(Number(textWindow.style.zIndex));

    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });
});

async function renderHost({
  hostRef,
  onPanelIntent,
  disabledPanelIds = [],
  children
}: {
  hostRef?: React.RefObject<WorkbenchWindowHostHandle | null>;
  onPanelIntent: (panelId: FloatingPanelId) => void;
  disabledPanelIds?: readonly FloatingPanelId[];
  children?: React.ReactNode;
}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider locale="en">
        <WorkbenchWindowHost
          ref={hostRef}
          canonicalRoot="project-window-host"
          viewportRect={{ x: 0, y: 0, width: 1440, height: 900 }}
          interactionBlocked={false}
          disabledPanelIds={disabledPanelIds}
          onPanelIntent={onPanelIntent}
          renderPanelBody={(panelId) => <div>{panelId} content</div>}
        >
          {children}
        </WorkbenchWindowHost>
      </I18nProvider>
    );
  });
  return { container, root };
}

function RegisteredTextWindow(): React.ReactElement {
  const window = useWorkbenchWindow(textEditorWindowIdentity('notes/window.md'));
  return (
    <section
      data-testid="registered-text-window"
      style={{ zIndex: window.zIndex }}
      onPointerDown={window.onFocus}
    />
  );
}
