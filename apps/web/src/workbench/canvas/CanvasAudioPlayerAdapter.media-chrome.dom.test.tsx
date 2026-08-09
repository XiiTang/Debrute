import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { CanvasAudioPlayerAdapter } from './CanvasAudioPlayerAdapter.js';

describe('CanvasAudioPlayerAdapter with Media Chrome', () => {
  it('keeps the localized audio-player name after the custom element connects', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const consoleWarn = console.warn;
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: Parameters<typeof console.warn>) => {
      if (args[0] !== 'Media Chrome: No style sheet found on style tag of') {
        consoleWarn(...args);
      }
    });
    const trackListProperties = ['textTracks', 'audioTracks', 'videoRenditions'] as const;
    const trackListDescriptors = new Map(trackListProperties.map((property) => [
      property,
      Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, property)
    ]));
    for (const property of trackListProperties) {
      Object.defineProperty(HTMLMediaElement.prototype, property, {
        configurable: true,
        value: Object.assign([], {
          addEventListener: vi.fn(),
          removeEventListener: vi.fn()
        })
      });
    }
    try {
      await act(async () => {
        root.render(
          <CanvasAudioPlayerAdapter
            source="/media/theme.mp3"
            contentInteractionActive={false}
            playerLabel="Audio player"
            errorMessage="Unable to load theme.mp3."
            onError={() => undefined}
          />
        );
      });

      const controller = container.querySelector('media-controller');
      expect(controller?.getAttribute('role')).toBe('region');
      expect(controller?.getAttribute('aria-label')).toBe('Audio player');

      await act(async () => {
        root.render(
          <CanvasAudioPlayerAdapter
            source="/media/theme.mp3"
            contentInteractionActive={false}
            playerLabel="音频播放器"
            errorMessage="无法加载 theme.mp3。"
            onError={() => undefined}
          />
        );
      });
      expect(controller?.getAttribute('aria-label')).toBe('音频播放器');
    } finally {
      await act(async () => root.unmount());
      for (const property of trackListProperties) {
        const descriptor = trackListDescriptors.get(property);
        if (descriptor) {
          Object.defineProperty(HTMLMediaElement.prototype, property, descriptor);
        } else {
          Reflect.deleteProperty(HTMLMediaElement.prototype, property);
        }
      }
      warn.mockRestore();
      container.remove();
    }
  });
});
