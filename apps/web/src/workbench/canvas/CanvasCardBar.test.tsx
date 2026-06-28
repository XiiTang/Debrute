// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasCardBar, type CanvasCardBarProps } from './CanvasCardBar';
import { I18nProvider } from '../i18n';

describe('CanvasCardBar', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders canvas cards and switches active canvas on click', async () => {
    const onActiveCanvasChange = vi.fn();
    const props = propsFixture({ onActiveCanvasChange });
    const html = renderStaticWithI18n(<CanvasCardBar {...props} />);

    expect(html).toContain('db-floating-bar canvas-card-bar');
    expect(html).toContain('db-button');
    expect(html).toContain('db-button--sm');
    expect(html).toContain('db-icon-button');
    expect(html).toContain('db-canvas-card');
    expect(html).toContain('db-canvas-control');
    expect(html).toContain('aria-pressed="true"');

    await withRenderedCardBar(props, async ({ container }) => {
      await act(async () => {
        buttonByText(container, 'storyboard').click();
      });
    });

    expect(onActiveCanvasChange).toHaveBeenCalledWith('storyboard');
  });

  it('submits canvas menu actions without browser prompt or confirm dialogs', async () => {
    const onCreateCanvas = vi.fn(async () => undefined);
    const onRenameCanvas = vi.fn(async () => undefined);
    const onDeleteCanvas = vi.fn(async () => undefined);
    const prompt = vi.fn(() => 'prompted');
    const confirm = vi.fn(() => true);
    vi.stubGlobal('prompt', prompt);
    vi.stubGlobal('confirm', confirm);

    await withRenderedCardBar(propsFixture({
      canvasOrder: ['canvas-1'],
      onCreateCanvas,
      onRenameCanvas,
      onDeleteCanvas
    }), async ({ container }) => {
      await act(async () => {
        buttonByText(container, 'New Canvas').click();
      });
      await act(async () => {
        const input = queryRequired<HTMLInputElement>(container, 'input[name="nextCanvasId"]');
        input.value = 'renamed';
        queryRequired<HTMLFormElement>(container, 'form.canvas-card-rename-form')
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await act(async () => {
        buttonByText(container, 'Delete').click();
        buttonByText(container, 'Confirm Delete').click();
      });
    });

    expect(onCreateCanvas).toHaveBeenCalled();
    expect(onRenameCanvas).toHaveBeenCalledWith({ canvasId: 'canvas-1', nextCanvasId: 'renamed' });
    expect(onDeleteCanvas).toHaveBeenCalledWith({ canvasId: 'canvas-1' });
    expect(prompt).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('renders inline rename and explicit delete confirmation controls in the menu', () => {
    const html = renderStaticWithI18n(<CanvasCardBar {...propsFixture({ canvasOrder: ['canvas-1'] })} />);

    expect(html).toContain('name="nextCanvasId"');
    expect(html).toContain('value="canvas-1"');
    expect(html).toContain('aria-label="Rename canvas-1"');
    expect(html).toContain('hidden=""');
    expect(html).toContain('Confirm Delete');
    expect(html).toContain('db-menu');
  });
});

function renderStaticWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      {element}
    </I18nProvider>
  );
}

async function withRenderedCardBar(
  props: CanvasCardBarProps,
  callback: (input: { container: HTMLDivElement; root: Root }) => Promise<void>
): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <CanvasCardBar {...props} />
        </I18nProvider>
      );
    });
    await callback({ container, root });
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
}

function propsFixture(overrides: Partial<CanvasCardBarProps> = {}): CanvasCardBarProps {
  return {
    canvasOrder: ['canvas-1', 'storyboard'],
    activeCanvasId: 'canvas-1',
    onActiveCanvasChange: () => undefined,
    onCreateCanvas: async () => undefined,
    onRenameCanvas: async () => undefined,
    onDeleteCanvas: async () => undefined,
    onReorderCanvases: async () => undefined,
    ...overrides
  };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => candidate.textContent === text);
  if (!button) {
    throw new Error(`Expected button: ${text}`);
  }
  return button;
}

function queryRequired<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Expected element: ${selector}`);
  }
  return element;
}
