import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } from '../CanvasTextRenderProfile.test-support';
import {
  CanvasTextProjectFontEnvironment,
  CanvasTextProjectFontEnvironmentProvider,
  useCanvasTextProjectFontEnvironment
} from './CanvasTextProjectFontEnvironment';

describe('CanvasTextProjectFontEnvironmentProvider', { tags: ['canvas-text'] }, () => {
  it('survives the StrictMode effect probe and disposes after the real unmount', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const dispose = vi.spyOn(CanvasTextProjectFontEnvironment.prototype, 'dispose');
    let mounted = true;

    try {
      await act(async () => {
        root.render(
          <React.StrictMode>
            <CanvasTextProjectFontEnvironmentProvider profile={DEFAULT_CANVAS_TEXT_RENDER_PROFILE}>
              <EnvironmentProbe />
            </CanvasTextProjectFontEnvironmentProvider>
          </React.StrictMode>
        );
      });
      await act(async () => Promise.resolve());

      expect(container.textContent).toBe('ready');
      expect(dispose).not.toHaveBeenCalled();

      await act(async () => root.unmount());
      mounted = false;
      await act(async () => Promise.resolve());

      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      if (mounted) {
        await act(async () => root.unmount());
      }
      container.remove();
      dispose.mockRestore();
    }
  });
});

function EnvironmentProbe(): React.ReactElement {
  useCanvasTextProjectFontEnvironment();
  return <span>ready</span>;
}
