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
    expect(html).toContain('canvas-card-delete');
    expect(html).toContain('db-canvas-control');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('--canvas-card-name-ch');

    await withRenderedCardBar(props, async ({ container }) => {
      await act(async () => {
        buttonByText(container, 'Storyboard').click();
      });
    });

    expect(onActiveCanvasChange).toHaveBeenCalledWith('storyboard');
  });

  it('renames a canvas display name from an inline editor opened by double click', async () => {
    const onRenameCanvas = vi.fn(async () => undefined);

    await withRenderedCardBar(propsFixture({
      canvases: [{ id: 'canvas-1', name: '故事板' }],
      onRenameCanvas
    }), async ({ container }) => {
      await act(async () => {
        buttonByText(container, '故事板').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      });
      const input = queryRequired<HTMLInputElement>(container, 'input[name="name"]');
      expect(input.value).toBe('故事板');
      expect(document.activeElement).toBe(input);

      await act(async () => {
        input.value = '  分镜  ';
        queryRequired<HTMLFormElement>(container, 'form.canvas-card-rename-form')
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    });

    expect(onRenameCanvas).toHaveBeenCalledWith({ canvasId: 'canvas-1', name: '分镜' });
  });

  it('does not submit a rename when the display name is unchanged after trim', async () => {
    const onRenameCanvas = vi.fn(async () => undefined);

    await withRenderedCardBar(propsFixture({
      canvases: [{ id: 'canvas-1', name: '故事板' }],
      onRenameCanvas
    }), async ({ container }) => {
      await act(async () => {
        buttonByText(container, '故事板').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      });
      const input = queryRequired<HTMLInputElement>(container, 'input[name="name"]');

      await act(async () => {
        input.value = '  故事板  ';
        queryRequired<HTMLFormElement>(container, 'form.canvas-card-rename-form')
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    });

    expect(onRenameCanvas).not.toHaveBeenCalled();
  });

  it('cancels inline canvas rename on Escape', async () => {
    const onRenameCanvas = vi.fn(async () => undefined);

    await withRenderedCardBar(propsFixture({
      canvases: [{ id: 'canvas-1', name: 'Canvas 1' }],
      onRenameCanvas
    }), async ({ container }) => {
      await act(async () => {
        buttonByText(container, 'Canvas 1').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      });
      const input = queryRequired<HTMLInputElement>(container, 'input[name="name"]');
      input.value = 'renamed';

      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, cancelable: true }));
      });

      expect(container.querySelector('input[name="name"]')).toBeNull();
    });

    expect(onRenameCanvas).not.toHaveBeenCalled();
  });

  it('deletes a canvas from the card close control without switching canvases', async () => {
    const onActiveCanvasChange = vi.fn();
    const onDeleteCanvas = vi.fn(async () => undefined);
    const prompt = vi.fn(() => 'prompted');
    const confirm = vi.fn(() => true);
    vi.stubGlobal('prompt', prompt);
    vi.stubGlobal('confirm', confirm);

    await withRenderedCardBar(propsFixture({
      canvases: [{ id: 'canvas-1', name: 'Canvas 1' }],
      onActiveCanvasChange,
      onDeleteCanvas
    }), async ({ container }) => {
      await act(async () => {
        queryRequired<HTMLButtonElement>(container, '.canvas-card-delete').click();
      });
    });

    expect(onDeleteCanvas).toHaveBeenCalledWith({ canvasId: 'canvas-1' });
    expect(onActiveCanvasChange).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('renders direct rename and delete controls without a card menu', () => {
    const html = renderStaticWithI18n(<CanvasCardBar {...propsFixture({ canvases: [{ id: 'canvas-1', name: 'Canvas 1' }] })} />);

    expect(html).toContain('aria-label="Delete Canvas 1"');
    expect(html).toContain('canvas-card-delete');
    expect(html).not.toContain('canvas-card-menu');
    expect(html).not.toContain('db-menu');
    expect(html).not.toContain('Confirm Delete');
    expect(html).not.toContain('Canvas actions');
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
    canvases: [
      { id: 'canvas-1', name: 'Canvas 1' },
      { id: 'storyboard', name: 'Storyboard' }
    ],
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
