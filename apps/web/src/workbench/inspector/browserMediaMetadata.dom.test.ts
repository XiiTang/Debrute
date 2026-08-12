import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBrowserMediaMetadata } from './browserMediaMetadata';

describe('readBrowserMediaMetadata', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads video dimensions and duration before releasing the temporary source', async () => {
    const video = document.createElement('video');
    const load = vi.fn();
    Object.defineProperties(video, {
      duration: { configurable: true, value: 1.25 },
      load: { configurable: true, value: load },
      videoHeight: { configurable: true, value: 180 },
      videoWidth: { configurable: true, value: 320 }
    });
    vi.spyOn(document, 'createElement').mockReturnValue(video);

    const result = readBrowserMediaMetadata('video', '/files/raw/sample.mp4', new AbortController().signal);
    video.dispatchEvent(new Event('loadedmetadata'));

    await expect(result).resolves.toEqual({
      durationSeconds: 1.25,
      dimensions: { width: 320, height: 180 }
    });
    expect(video.hasAttribute('src')).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reads audio duration without inventing dimensions', async () => {
    const audio = document.createElement('audio');
    const load = vi.fn();
    Object.defineProperties(audio, {
      duration: { configurable: true, value: 2.5 },
      load: { configurable: true, value: load }
    });
    vi.spyOn(document, 'createElement').mockReturnValue(audio);

    const result = readBrowserMediaMetadata('audio', '/files/raw/sample.wav', new AbortController().signal);
    audio.dispatchEvent(new Event('loadedmetadata'));

    await expect(result).resolves.toEqual({ durationSeconds: 2.5 });
    expect(audio.hasAttribute('src')).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('releases the temporary source when the request is aborted', async () => {
    const audio = document.createElement('audio');
    const load = vi.fn();
    Object.defineProperty(audio, 'load', { configurable: true, value: load });
    vi.spyOn(document, 'createElement').mockReturnValue(audio);
    const controller = new AbortController();

    const result = readBrowserMediaMetadata('audio', '/files/raw/sample.wav', controller.signal);
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(audio.hasAttribute('src')).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not create or load media for an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const createElement = vi.spyOn(document, 'createElement');

    const result = readBrowserMediaMetadata(
      'audio',
      '/files/raw/sample.wav',
      controller.signal
    );

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(createElement).not.toHaveBeenCalled();
  });
});
