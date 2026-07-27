import { describe, expect, it } from 'vitest';
import { CanvasTextPreviewRasterWorkerClient } from './CanvasTextPreviewRasterWorkerClient.js';
import type {
  CanvasTextPreviewRasterWorkerRequest,
  CanvasTextPreviewRasterWorkerResponse
} from './CanvasTextPreviewRasterWorkerProtocol.js';

describe('CanvasTextPreviewRasterWorkerClient', { tags: ['canvas-text'] }, () => {
  it('rejects concurrent raster submission and registers each font only once', async () => {
    const worker = new FakeWorker();
    const client = new CanvasTextPreviewRasterWorkerClient(() => worker);

    const first = client.rasterize(requestFixture('first'));
    const concurrent = client.rasterize(requestFixture('concurrent'));

    expect(worker.requests).toEqual([
      expect.objectContaining({
        scene: expect.objectContaining({
          commands: [expect.objectContaining({ text: 'first' })]
        }),
        fontFaces: expect.any(Array)
      })
    ]);
    const firstPng = new Blob(['first'], { type: 'image/png' });
    worker.respond({ id: worker.requests[0]!.id, ok: true, sourcePng: firstPng });
    await expect(first).resolves.toBe(firstPng);
    if (worker.requests[1]) {
      worker.respond({
        id: worker.requests[1].id,
        ok: true,
        sourcePng: new Blob(['unexpected'], { type: 'image/png' })
      });
    }
    await expect(concurrent).rejects.toThrow('already has an active request');

    const second = client.rasterize(requestFixture('second'));
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1]).toEqual(expect.objectContaining({
      scene: expect.objectContaining({
        commands: [expect.objectContaining({ text: 'second' })]
      })
    }));
    expect(worker.requests[1]).not.toHaveProperty('fontFaces');

    const secondPng = new Blob(['second'], { type: 'image/png' });
    worker.respond({ id: worker.requests[1]!.id, ok: true, sourcePng: secondPng });
    await expect(second).resolves.toBe(secondPng);
  });

  it('rejects the active and future work when the Worker itself fails', async () => {
    const worker = new FakeWorker();
    const client = new CanvasTextPreviewRasterWorkerClient(() => worker);
    const first = client.rasterize(requestFixture('first'));

    worker.fail('worker crashed');

    await expect(first).rejects.toThrow('worker crashed');
    await expect(client.rasterize(requestFixture('second'))).rejects.toThrow(
      'worker crashed'
    );
  });

  it('releases the active slot when Worker submission throws synchronously', async () => {
    const worker = new FakeWorker();
    const client = new CanvasTextPreviewRasterWorkerClient(() => worker);
    worker.throwOnNextPostMessage = true;

    await expect(client.rasterize(requestFixture('invalid'))).rejects.toThrow('clone failed');

    const next = client.rasterize(requestFixture('next'));
    expect(worker.requests).toHaveLength(1);
    const sourcePng = new Blob(['next'], { type: 'image/png' });
    worker.respond({ id: worker.requests[0]!.id, ok: true, sourcePng });
    await expect(next).resolves.toBe(sourcePng);
  });
});

function requestFixture(text: string) {
  return {
    scene: {
      background: 'white',
      commands: [{
        kind: 'text' as const,
        x: 0,
        y: 0,
        width: 320,
        height: 20,
        text,
        textX: 0,
        textAlign: 'left' as const,
        color: 'black',
        background: 'transparent',
        fontFamily: 'monospace',
        fontSize: '16px',
        fontWeight: '400',
        fontVariantLigatures: 'normal',
        fontVariantNumeric: 'normal',
        letterSpacing: '0px',
        wordSpacing: '0px',
        textDecorationLine: 'none',
        textDecorationColor: 'black',
        textDecorationStyle: 'solid'
      }]
    },
    fontResourceKey: 'font-a',
    fontFaces: [{
      family: 'font-a',
      bytes: new Uint8Array([1]).buffer,
      descriptors: { weight: '400', style: 'normal', stretch: '100%' }
    }],
    width: 320,
    height: 160,
    scale: 4
  };
}

class FakeWorker {
  readonly requests: CanvasTextPreviewRasterWorkerRequest[] = [];
  throwOnNextPostMessage = false;
  #messageListener: ((event: MessageEvent<CanvasTextPreviewRasterWorkerResponse>) => void) | undefined;
  #errorListener: ((event: ErrorEvent) => void) | undefined;

  postMessage(message: CanvasTextPreviewRasterWorkerRequest): void {
    if (this.throwOnNextPostMessage) {
      this.throwOnNextPostMessage = false;
      throw new Error('clone failed');
    }
    this.requests.push(message);
  }

  addEventListener(
    type: 'message' | 'error',
    listener: ((event: MessageEvent<CanvasTextPreviewRasterWorkerResponse>) => void)
      | ((event: ErrorEvent) => void)
  ): void {
    if (type === 'message') {
      this.#messageListener = listener as (event: MessageEvent<CanvasTextPreviewRasterWorkerResponse>) => void;
    } else {
      this.#errorListener = listener as (event: ErrorEvent) => void;
    }
  }

  respond(response: CanvasTextPreviewRasterWorkerResponse): void {
    this.#messageListener?.({ data: response } as MessageEvent<CanvasTextPreviewRasterWorkerResponse>);
  }

  fail(message: string): void {
    this.#errorListener?.({ message } as ErrorEvent);
  }
}
