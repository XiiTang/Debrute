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
  readonly onError: (message: string) => void;
  readonly errorMessage: string;
}

export function CanvasAudioPlayerAdapter({
  source,
  contentInteractionActive,
  onError,
  errorMessage
}: CanvasAudioPlayerAdapterProps): React.ReactElement {
  return (
    <div className="canvas-audio-player">
      <MediaController audio noHotkeys={!contentInteractionActive}>
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
