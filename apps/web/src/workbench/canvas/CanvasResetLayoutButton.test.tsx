import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CanvasResetLayoutButton } from './CanvasResetLayoutButton';

interface ButtonProps {
  disabled?: boolean;
  onClick(event: { stopPropagation(): void }): void;
}

describe('CanvasResetLayoutButton', () => {
  it('renders an enabled icon button and triggers canvas reset', () => {
    const onResetCanvasLayout = vi.fn();
    const element = CanvasResetLayoutButton({
      enabled: true,
      onResetCanvasLayout
    });
    const event = { stopPropagation: vi.fn() };

    (element.props as ButtonProps).onClick(event);

    expect(onResetCanvasLayout).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    const html = renderToStaticMarkup(element);
    expect(html).toContain('canvas-reset-layout-button');
    expect(html).toContain('data-testid="canvas-reset-layout-button"');
    expect(html).toContain('aria-label="Reset Canvas Layout"');
  });

  it('stays disabled when the active canvas has no manual nodes', () => {
    const onResetCanvasLayout = vi.fn();
    const element = CanvasResetLayoutButton({
      enabled: false,
      onResetCanvasLayout
    });

    (element.props as ButtonProps).onClick({ stopPropagation: vi.fn() });

    expect((element.props as ButtonProps).disabled).toBe(true);
    expect(onResetCanvasLayout).not.toHaveBeenCalled();
  });
});
