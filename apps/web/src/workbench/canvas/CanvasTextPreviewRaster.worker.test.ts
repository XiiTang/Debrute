import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CanvasTextPreviewRasterText,
  CanvasTextPreviewRasterWorkerRequest,
  CanvasTextPreviewRasterWorkerResponse
} from './CanvasTextPreviewRasterWorkerProtocol.js';
import './CanvasTextPreviewRaster.worker.js';

const workerScope = globalThis as unknown as {
  onmessage(event: MessageEvent<CanvasTextPreviewRasterWorkerRequest>): void;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CanvasTextPreviewRaster Worker contract', { tags: ['canvas-text'] }, () => {
  it('rejects an incomplete text scene instead of inventing typography defaults', async () => {
    const request = requestFixture('strict-scene');
    delete (request.scene.commands[0] as Partial<CanvasTextPreviewRasterText>).fontWeight;

    const response = await postToWorker(request);

    expect(response).toEqual({
      id: request.id,
      ok: false,
      message: 'Canvas text preview raster Worker received an incomplete text command.'
    });
  });

  it('rejects every font family that was not supplied by the managed resource', async () => {
    installRasterEnvironment(contextFixture());
    const request = requestFixture('managed-only');
    (request.scene.commands[0] as CanvasTextPreviewRasterText).fontFamily = 'monospace';

    const response = await postToWorker(request);

    expect(response).toEqual({
      id: request.id,
      ok: false,
      message: 'Canvas text preview raster scene contains an unmanaged font: monospace.'
    });
  });

  it('fails explicitly when the Worker 2D context lacks a required text capability', async () => {
    const context = contextFixture();
    delete context.letterSpacing;
    installRasterEnvironment(context);
    const request = requestFixture('missing-capability');

    const response = await postToWorker(request);

    expect(response).toEqual({
      id: request.id,
      ok: false,
      message: 'Canvas text preview raster Worker requires 2D context.letterSpacing.'
    });
  });

  it('rasterizes with the exact managed font when every required capability exists', async () => {
    installRasterEnvironment(contextFixture());
    const request = requestFixture('supported-capabilities');

    const response = await postToWorker(request);

    expect(response).toMatchObject({ id: request.id, ok: true });
  });
});

function postToWorker(
  request: CanvasTextPreviewRasterWorkerRequest
): Promise<CanvasTextPreviewRasterWorkerResponse> {
  return new Promise((resolve) => {
    vi.stubGlobal('postMessage', resolve);
    workerScope.onmessage({ data: request } as MessageEvent<CanvasTextPreviewRasterWorkerRequest>);
  });
}

function requestFixture(fontResourceKey: string): CanvasTextPreviewRasterWorkerRequest {
  return {
    id: 1,
    scene: {
      background: 'transparent',
      commands: [{
        kind: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 20,
        text: 'managed text',
        textX: 0,
        textAlign: 'left',
        color: '#fff',
        background: 'transparent',
        fontFamily: '"managed-font"',
        fontSize: '12px',
        fontWeight: '400',
        fontVariantLigatures: 'common-ligatures contextual',
        fontVariantNumeric: 'normal',
        letterSpacing: '0px',
        wordSpacing: '0px',
        textDecorationLine: 'none',
        textDecorationColor: '#fff',
        textDecorationStyle: 'solid'
      }],
    },
    fontResourceKey,
    fontFaces: [{
      family: 'managed-font',
      bytes: new Uint8Array([1]).buffer,
      descriptors: { weight: '400', style: 'normal', stretch: '100%' }
    }],
    width: 100,
    height: 20,
    scale: 1
  };
}

function installRasterEnvironment(context: Record<string, unknown>): void {
  class FontFaceMock {
    constructor(
      readonly family: string,
      _source: ArrayBuffer,
      readonly descriptors: FontFaceDescriptors
    ) {}

    async load(): Promise<FontFace> {
      return this as unknown as FontFace;
    }
  }
  class OffscreenCanvasMock {
    constructor(_width: number, _height: number) {}

    getContext(): OffscreenCanvasRenderingContext2D {
      return context as unknown as OffscreenCanvasRenderingContext2D;
    }

    async convertToBlob(): Promise<Blob> {
      return new Blob(['png'], { type: 'image/png' });
    }
  }
  vi.stubGlobal('FontFace', FontFaceMock);
  vi.stubGlobal('OffscreenCanvas', OffscreenCanvasMock);
  vi.stubGlobal('fonts', { add: vi.fn() });
}

function contextFixture(): Record<string, unknown> {
  return {
    clearRect: vi.fn(),
    scale: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    measureText: vi.fn(() => ({
      width: 72,
      actualBoundingBoxAscent: 9,
      actualBoundingBoxDescent: 3
    })),
    fillText: vi.fn(),
    restore: vi.fn(),
    fillStyle: '',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    fontKerning: 'auto',
    letterSpacing: '0px',
    wordSpacing: '0px'
  };
}
