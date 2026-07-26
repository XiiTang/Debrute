import type {
  CanvasTextPreviewRasterRequest,
  CanvasTextPreviewRasterWorkerRequest,
  CanvasTextPreviewRasterWorkerResponse
} from './CanvasTextPreviewRasterWorkerProtocol.js';

interface CanvasTextPreviewWorkerLike {
  postMessage(message: CanvasTextPreviewRasterWorkerRequest): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<CanvasTextPreviewRasterWorkerResponse>) => void
  ): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
}

interface ActiveRaster {
  id: number;
  request: CanvasTextPreviewRasterRequest;
  resolve(sourcePng: Blob): void;
  reject(error: Error): void;
}

export class CanvasTextPreviewRasterWorkerClient {
  readonly #worker: CanvasTextPreviewWorkerLike;
  readonly #workerFontResources = new Set<string>();
  #nextId = 1;
  #active: ActiveRaster | undefined;
  #failure: Error | undefined;

  constructor(createWorker: () => CanvasTextPreviewWorkerLike) {
    this.#worker = createWorker();
    this.#worker.addEventListener('message', (event) => this.#handleMessage(event.data));
    this.#worker.addEventListener('error', (event) => {
      this.#fail(new Error(event.message || 'Canvas text preview raster Worker failed.'));
    });
  }

  rasterize(request: CanvasTextPreviewRasterRequest): Promise<Blob> {
    if (this.#failure) {
      return Promise.reject(this.#failure);
    }
    if (this.#active) {
      return Promise.reject(new Error(
        'Canvas text preview raster Worker already has an active request.'
      ));
    }
    return new Promise((resolve, reject) => {
      const active = {
        id: this.#nextId++,
        request,
        resolve,
        reject
      } satisfies ActiveRaster;
      this.#active = active;
      const includeFont = !this.#workerFontResources.has(request.fontResourceKey);
      try {
        this.#worker.postMessage({
          id: active.id,
          scene: request.scene,
          fontResourceKey: request.fontResourceKey,
          ...(includeFont ? { fontFaces: request.fontFaces } : {}),
          width: request.width,
          height: request.height,
          scale: request.scale
        });
      } catch (error) {
        this.#active = undefined;
        reject(error instanceof Error
          ? error
          : new Error('Canvas text preview raster Worker submission failed.'));
      }
    });
  }

  #handleMessage(response: CanvasTextPreviewRasterWorkerResponse): void {
    const active = this.#active;
    if (!active || response.id !== active.id) {
      this.#fail(new Error('Canvas text preview raster Worker returned an unexpected response.'));
      return;
    }
    this.#active = undefined;
    if (response.ok) {
      this.#workerFontResources.add(active.request.fontResourceKey);
      active.resolve(response.sourcePng);
    } else {
      active.reject(new Error(response.message));
    }
  }

  #fail(error: Error): void {
    if (this.#failure) {
      return;
    }
    this.#failure = error;
    const active = this.#active;
    this.#active = undefined;
    active?.reject(error);
  }
}

let sharedClient: CanvasTextPreviewRasterWorkerClient | undefined;

export function rasterizeCanvasTextPreviewInWorker(
  request: CanvasTextPreviewRasterRequest
): Promise<Blob> {
  sharedClient ??= new CanvasTextPreviewRasterWorkerClient(() => new Worker(
    new URL('./CanvasTextPreviewRaster.worker.ts', import.meta.url),
    { type: 'module', name: 'canvas-text-preview-raster' }
  ));
  return sharedClient.rasterize(request);
}
