import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('media-chrome/react', async () => {
  const ReactModule = await import('react');
  type MockProps = React.PropsWithChildren<Record<string, unknown>>;
  const mediaComponent = (tagName: string) => ReactModule.forwardRef<HTMLElement, MockProps>(function MockMediaChromeComponent({
    children,
    ...props
  }, ref) {
    return ReactModule.createElement(tagName, { ...props, ref }, children as React.ReactNode);
  });
  return {
    MediaControlBar: mediaComponent('media-control-bar'),
    MediaController: mediaComponent('media-controller'),
    MediaMuteButton: mediaComponent('media-mute-button'),
    MediaPlayButton: mediaComponent('media-play-button'),
    MediaTimeDisplay: mediaComponent('media-time-display'),
    MediaTimeRange: mediaComponent('media-time-range'),
    MediaVolumeRange: mediaComponent('media-volume-range')
  };
});

import { CanvasAudioPlayerAdapter } from './CanvasAudioPlayerAdapter';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CanvasAudioPlayerAdapter', () => {
  it('uses a stable native audio element and only the project audio control set', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
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

      const audio = container.querySelector('audio');
      expect(audio?.getAttribute('src')).toBe('/media/theme.mp3');
      expect(audio?.getAttribute('preload')).toBe('none');
      expect(audio?.hasAttribute('controls')).toBe(false);
      expect(container.querySelector('media-controller')?.hasAttribute('audio')).toBe(true);
      expect(container.querySelectorAll('media-play-button')).toHaveLength(1);
      expect(container.querySelectorAll('media-time-range')).toHaveLength(1);
      expect(container.querySelectorAll('media-time-display')).toHaveLength(1);
      expect(container.querySelectorAll('media-mute-button')).toHaveLength(1);
      expect(container.querySelectorAll('media-volume-range')).toHaveLength(1);
      expect(container.querySelectorAll('media-captions-button, media-fullscreen-button, media-pip-button, media-playback-rate-button')).toHaveLength(0);
      expect(container.querySelectorAll('[data-canvas-direct-manipulation="true"]')).toHaveLength(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('enables Media Chrome hotkeys only during Content Activation without replacing the player', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
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
      const audio = container.querySelector('audio');
      expect(container.querySelector('media-controller')?.hasAttribute('nohotkeys')).toBe(true);

      await act(async () => {
        root.render(
          <CanvasAudioPlayerAdapter
            source="/media/theme.mp3"
            contentInteractionActive
            playerLabel="Audio player"
            errorMessage="Unable to load theme.mp3."
            onError={() => undefined}
          />
        );
      });

      expect(container.querySelector('audio')).toBe(audio);
      expect(container.querySelector('media-controller')?.hasAttribute('nohotkeys')).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('reports native media errors through the Content Region contract', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onError = vi.fn();
    try {
      await act(async () => {
        root.render(
          <CanvasAudioPlayerAdapter
            source="/media/theme.mp3"
            contentInteractionActive
            playerLabel="Audio player"
            errorMessage="Unable to load theme.mp3."
            onError={onError}
          />
        );
      });
      await act(async () => {
        container.querySelector('audio')?.dispatchEvent(new Event('error'));
      });
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith('Unable to load theme.mp3.');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
