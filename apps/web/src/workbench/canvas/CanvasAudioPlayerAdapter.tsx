import React from 'react';
import {
  MediaControlBar,
  MediaController,
  MediaMuteButton,
  MediaPlayButton,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange
} from 'media-chrome/react';

export interface CanvasAudioPlayerAdapterProps {
  readonly source: string;
  readonly contentInteractionActive: boolean;
  readonly playerLabel: string;
  readonly onError: (message: string) => void;
  readonly errorMessage: string;
}

export function CanvasAudioPlayerAdapter({
  source,
  contentInteractionActive,
  playerLabel,
  onError,
  errorMessage
}: CanvasAudioPlayerAdapterProps): React.ReactElement {
  const setMediaController = React.useCallback((controller: HTMLElement | null) => {
    controller?.setAttribute('aria-label', playerLabel);
  }, [playerLabel]);

  return (
    <div className="canvas-audio-player">
      <MediaController ref={setMediaController} audio noHotkeys={!contentInteractionActive}>
        <audio
          slot="media"
          src={source}
          preload="none"
          onError={() => onError(errorMessage)}
        />
        <MediaControlBar>
          <MediaPlayButton />
          <MediaTimeRange data-canvas-direct-manipulation="true" />
          <MediaTimeDisplay showDuration />
          <MediaMuteButton />
          <MediaVolumeRange data-canvas-direct-manipulation="true" />
        </MediaControlBar>
      </MediaController>
    </div>
  );
}
