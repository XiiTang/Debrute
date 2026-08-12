export interface BrowserMediaMetadata {
  durationSeconds?: number;
  dimensions?: { width: number; height: number };
}

export function readBrowserMediaMetadata(
  kind: 'audio' | 'video',
  fileUrl: string,
  signal: AbortSignal
): Promise<BrowserMediaMetadata> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const media = document.createElement(kind);
    const cleanup = () => {
      media.removeEventListener('loadedmetadata', loaded);
      media.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
      media.removeAttribute('src');
      media.load();
    };
    const loaded = () => {
      const metadata: BrowserMediaMetadata = {
        ...(Number.isFinite(media.duration) ? { durationSeconds: media.duration } : {})
      };
      if (media instanceof HTMLVideoElement && media.videoWidth > 0 && media.videoHeight > 0) {
        metadata.dimensions = { width: media.videoWidth, height: media.videoHeight };
      }
      cleanup();
      resolve(metadata);
    };
    const failed = () => {
      cleanup();
      reject(new Error('Browser media metadata is unavailable.'));
    };
    const aborted = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    media.preload = 'metadata';
    media.addEventListener('loadedmetadata', loaded);
    media.addEventListener('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    media.src = fileUrl;
    media.load();
  });
}
