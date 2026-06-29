// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CanvasResetLayoutButton } from './CanvasResetLayoutButton';
import { I18nProvider } from '../i18n';

describe('CanvasResetLayoutButton', () => {
  it('renders an enabled icon button and triggers canvas reset', async () => {
    const onResetCanvasLayout = vi.fn();
    const html = renderStaticWithI18n(
      <CanvasResetLayoutButton
        enabled
        onResetCanvasLayout={onResetCanvasLayout}
      />
    );

    expect(html).toContain('canvas-reset-layout-button');
    expect(html).toContain('db-canvas-control');
    expect(html).toContain('data-testid="canvas-reset-layout-button"');
    expect(html).toContain('aria-label="Reset Canvas Layout"');
    expect(html).not.toContain('db-floating-bar canvas-reset-layout-button');

    await withRenderedButton({ enabled: true, onResetCanvasLayout }, async ({ button }) => {
      await act(async () => {
        button.click();
      });
    });

    expect(onResetCanvasLayout).toHaveBeenCalled();
  });

  it('stays disabled when the active canvas has no manual nodes', async () => {
    const onResetCanvasLayout = vi.fn();

    await withRenderedButton({ enabled: false, onResetCanvasLayout }, async ({ button }) => {
      expect(button.disabled).toBe(true);
      await act(async () => {
        button.click();
      });
    });

    expect(onResetCanvasLayout).not.toHaveBeenCalled();
  });
});

function renderStaticWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      {element}
    </I18nProvider>
  );
}

async function withRenderedButton(
  props: { enabled: boolean; onResetCanvasLayout(): void },
  callback: (input: { button: HTMLButtonElement; root: Root }) => Promise<void>
): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <CanvasResetLayoutButton {...props} />
        </I18nProvider>
      );
    });
    const button = container.querySelector<HTMLButtonElement>('button');
    if (!button) {
      throw new Error('Expected reset layout button');
    }
    await callback({ button, root });
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
}
