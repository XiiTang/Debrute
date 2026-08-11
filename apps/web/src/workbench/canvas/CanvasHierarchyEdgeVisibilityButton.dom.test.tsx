import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/index.js';
import { CanvasHierarchyEdgeVisibilityButton } from './CanvasHierarchyEdgeVisibilityButton.js';

describe('CanvasHierarchyEdgeVisibilityButton', { tags: ['settings'] }, () => {
  it('is always operable and uses Eye and EyeOff to represent hierarchy-edge visibility', async () => {
    const onHierarchyEdgesVisibleChange = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    const render = async (hierarchyEdgesVisible: boolean) => {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasHierarchyEdgeVisibilityButton
              hierarchyEdgesVisible={hierarchyEdgesVisible}
              onHierarchyEdgesVisibleChange={onHierarchyEdgesVisibleChange}
            />
          </I18nProvider>
        );
      });
    };

    try {
      await render(true);
      const button = requireButton(container);
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-label')).toBe('Hide hierarchy edges');
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(button.querySelector('[data-debrute-icon="eye"]')).not.toBeNull();
      expect(button.querySelector('[data-debrute-icon="eye-off"]')).toBeNull();

      await act(async () => {
        button.click();
      });
      expect(onHierarchyEdgesVisibleChange).toHaveBeenCalledWith(false);

      await render(false);
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-label')).toBe('Show hierarchy edges');
      expect(button.getAttribute('aria-pressed')).toBe('false');
      expect(button.querySelector('[data-debrute-icon="eye"]')).toBeNull();
      expect(button.querySelector('[data-debrute-icon="eye-off"]')).not.toBeNull();

      await act(async () => {
        button.click();
      });
      expect(onHierarchyEdgesVisibleChange).toHaveBeenLastCalledWith(true);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});

function requireButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="canvas-hierarchy-edge-visibility-button"]'
  );
  if (!button) {
    throw new Error('Expected hierarchy edge visibility button.');
  }
  return button;
}
