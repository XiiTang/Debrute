export interface CanvasPreviewImageForHandoff {
  src: string;
  loadKey: string;
  previewWidth: number;
}

export function scheduleCanvasImageHandoffAfterPaint(
  callback: () => void,
  scheduler?: {
    requestFrame: (callback: FrameRequestCallback) => number;
    cancelFrame: (handle: number) => void;
  }
): () => void {
  const requestFrame = scheduler?.requestFrame ?? window.requestAnimationFrame.bind(window);
  const cancelFrame = scheduler?.cancelFrame ?? window.cancelAnimationFrame.bind(window);
  let cancelled = false;
  let firstFrame: number | undefined;
  let secondFrame: number | undefined;

  firstFrame = requestFrame(() => {
    firstFrame = undefined;
    if (cancelled) {
      return;
    }
    secondFrame = requestFrame(() => {
      secondFrame = undefined;
      if (!cancelled) {
        callback();
      }
    });
  });

  return () => {
    cancelled = true;
    if (firstFrame !== undefined) {
      cancelFrame(firstFrame);
    }
    if (secondFrame !== undefined) {
      cancelFrame(secondFrame);
    }
  };
}

export function preloadCanvasImageForHandoff(input: {
  image: CanvasPreviewImageForHandoff;
  resolveLoaded: (loadKey: string) => void;
  rejectLoaded: (loadKey: string) => void;
  createImage?: (() => HTMLImageElement) | undefined;
  scheduler?: Parameters<typeof scheduleCanvasImageHandoffAfterPaint>[1];
}): () => void {
  const image = input.createImage?.() ?? new Image();
  let cancelled = false;
  let settled = false;
  let loadStarted = false;
  let cancelHandoff: (() => void) | undefined;

  const reject = () => {
    if (cancelled || settled) {
      return;
    }
    settled = true;
    input.rejectLoaded(input.image.loadKey);
  };

  const resolveAfterDecode = () => {
    if (cancelled || settled) {
      return;
    }
    settled = true;
    cancelHandoff = scheduleCanvasImageHandoffAfterPaint(() => {
      cancelHandoff = undefined;
      if (!cancelled) {
        input.resolveLoaded(input.image.loadKey);
      }
    }, input.scheduler);
  };

  const load = () => {
    if (cancelled || settled || loadStarted) {
      return;
    }
    loadStarted = true;
    void image.decode().then(resolveAfterDecode, reject);
  };

  image.decoding = 'async';
  image.addEventListener('load', load);
  image.addEventListener('error', reject);
  image.src = input.image.src;

  if (image.complete) {
    if (image.naturalWidth > 0) {
      load();
    } else {
      reject();
    }
  }

  return () => {
    cancelled = true;
    cancelHandoff?.();
    image.removeEventListener('load', load);
    image.removeEventListener('error', reject);
    image.src = '';
  };
}
