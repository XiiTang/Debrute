import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProjectedCanvasNode } from './CanvasScene';
import { I18nProvider } from '../i18n/index';

vi.mock('./CanvasAudioPlayerAdapter', () => ({
  CanvasAudioPlayerAdapter: ({
    source,
    contentInteractionActive,
    playerLabel,
    errorMessage,
    onError
  }: {
    source: string;
    contentInteractionActive: boolean;
    playerLabel: string;
    errorMessage: string;
    onError: (message: string) => void;
  }) => (
    <div
      data-testid="audio-player-adapter"
      data-source={source}
      data-content-active={contentInteractionActive ? 'true' : 'false'}
      data-player-label={playerLabel}
    >
      <button type="button" data-testid="audio-error" onClick={() => onError(errorMessage)}>fail</button>
    </div>
  )
}));

import { CanvasAudioNodeContent } from './CanvasAudioNodeContent';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CanvasAudioNodeContent', () => {
  it('keeps one player mounted across activation changes under a stable Content Region', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await renderAudio(root, audioNode(), false);
      const player = await waitForAudioPlayer(container);
      expect(container.querySelector('.db-canvas-node-titlebar')?.getAttribute('data-canvas-node-zone')).toBe('manipulation');
      expect(container.querySelector('.canvas-audio-content')?.getAttribute('data-canvas-node-zone')).toBe('content');
      expect(player.getAttribute('data-content-active')).toBe('false');
      expect(player.getAttribute('data-player-label')).toBe('Audio player');

      await renderAudio(root, audioNode(), true);
      expect(container.querySelector('[data-testid="audio-player-adapter"]')).toBe(player);
      expect(player.getAttribute('data-content-active')).toBe('true');

      await renderAudio(root, audioNode(), false);
      expect(container.querySelector('[data-testid="audio-player-adapter"]')).toBe(player);
      expect(player.getAttribute('data-content-active')).toBe('false');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('discards a failed player, ends activation, and retries from the whole Content Region without autoplay', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onContentError = vi.fn();
    try {
      await renderAudio(root, audioNode(), true, onContentError);
      const failedPlayer = await waitForAudioPlayer(container);
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="audio-error"]')?.click();
      });

      expect(onContentError).toHaveBeenCalledWith('media/theme.mp3');
      expect(container.querySelector('[data-testid="audio-player-adapter"]')).toBeNull();
      const errorSurface = container.querySelector('.canvas-content-error');
      expect(errorSurface?.textContent).toContain('Click to retry');
      expect(errorSurface?.querySelector('button')).toBeNull();

      await renderAudio(root, audioNode(), false, onContentError);
      await renderAudio(root, audioNode(), true, onContentError);
      const retryPlayer = await waitForAudioPlayer(container);
      expect(retryPlayer).not.toBe(failedPlayer);
      expect(retryPlayer.getAttribute('data-content-active')).toBe('true');
      expect(container.querySelector('.canvas-content-error')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('ends an initially active unavailable audio Content Region', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onContentError = vi.fn();
    const available = audioNode();
    const unavailable: ProjectedCanvasNode = {
      ...available,
      availability: { state: 'missing', message: 'Audio file is missing.' }
    };
    try {
      await renderAudio(root, unavailable, true, onContentError);
      expect(onContentError).toHaveBeenCalledWith('media/theme.mp3');
      expect(container.querySelector('.canvas-content-error')?.textContent).toContain('Audio file is missing.');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

async function renderAudio(
  root: ReturnType<typeof createRoot>,
  node: ProjectedCanvasNode,
  contentInteractionActive: boolean,
  onContentError: (projectRelativePath: string) => void = () => undefined
): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider locale="en">
        <CanvasAudioNodeContent
          node={node}
          contentInteractionActive={contentInteractionActive}
          onContentError={onContentError}
        />
      </I18nProvider>
    );
  });
}

async function waitForAudioPlayer(container: ParentNode): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const player = container.querySelector<HTMLElement>('[data-testid="audio-player-adapter"]');
    if (player) {
      return player;
    }
    await act(async () => Promise.resolve());
  }
  throw new Error('Expected audio player adapter.');
}

function audioNode(): ProjectedCanvasNode {
  return {
    projectRelativePath: 'media/theme.mp3',
    displayName: 'theme.mp3',
    nodeKind: 'file',
    mediaKind: 'audio',
    x: 0,
    y: 0,
    width: 520,
    height: 120,
    z: 0,
    availability: {
      state: 'available',
      size: 10_000,
      mimeType: 'audio/mpeg',
      fileUrl: '/api/workbench/bindings/p/files/raw/media/theme.mp3?v=rev-a',
      revision: 'rev-a'
    }
  };
}
