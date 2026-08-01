import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasTextFontResource } from '../CanvasTextRenderProfile.js';
import type {
  CanvasTextFontSubsetRequest,
  CanvasTextFontSubsetResponse
} from './CanvasTextFontSubsetProtocol.js';
import { createCanvasTextPreviewFontSession } from './CanvasTextPreviewFontSession.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CanvasTextPreviewFontSession', { tags: ['canvas-text'] }, () => {
  it('rejects malformed coverage before starting a Worker', () => {
    const workerFactory = vi.fn();
    const session = createCanvasTextPreviewFontSession({
      resource: fontResource(),
      document: fontDocumentMock().document,
      workerFactory
    });

    expect(() => session.prepareCoverage(
      Uint32Array.from([0x42, 0x41]),
      new AbortController().signal
    ))
      .toThrow('strictly sorted unique');
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it('reuses a covering active subset and atomically replaces it on a coverage miss', async () => {
    installFontFaceMock();
    const fontDocument = fontDocumentMock();
    const workers: FakeWorker[] = [];
    const session = createCanvasTextPreviewFontSession({
      resource: fontResource(),
      document: fontDocument.document,
      workerFactory: () => {
        const worker = new FakeWorker(successResponse);
        workers.push(worker);
        return worker as unknown as Worker;
      }
    });

    const first = (await session.prepareCoverage(
      Uint32Array.from([0x20, 0x41]),
      new AbortController().signal
    )).activate();
    const reused = (await session.prepareCoverage(
      Uint32Array.from([0x41]),
      new AbortController().signal
    )).activate();
    const replacement = (await session.prepareCoverage(
      Uint32Array.from([0x42]),
      new AbortController().signal
    )).activate();

    expect(reused).toBe(first);
    expect(replacement).not.toBe(first);
    expect(workers).toHaveLength(2);
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
    expect(fontDocument.add).toHaveBeenCalledTimes(2);
    expect(fontDocument.delete).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous active subset after replacement failure and does not retry the miss', async () => {
    installFontFaceMock();
    const fontDocument = fontDocumentMock();
    let workerCount = 0;
    const session = createCanvasTextPreviewFontSession({
      resource: fontResource(),
      document: fontDocument.document,
      workerFactory: () => {
        workerCount += 1;
        return new FakeWorker(workerCount === 1 ? successResponse : errorResponse) as unknown as Worker;
      }
    });

    const active = (await session.prepareCoverage(
      Uint32Array.from([0x41]),
      new AbortController().signal
    )).activate();
    await expect(session.prepareCoverage(
      Uint32Array.from([0x42]),
      new AbortController().signal
    )).rejects.toThrow('subset failed');
    await expect(session.prepareCoverage(
      Uint32Array.from([0x43]),
      new AbortController().signal
    )).rejects.toThrow('subset failed');
    const covering = await session.prepareCoverage(
      Uint32Array.from([0x41]),
      new AbortController().signal
    );
    expect(covering.activate()).toBe(active);

    expect(workerCount).toBe(2);
    expect(fontDocument.delete).not.toHaveBeenCalled();
  });

  it('terminates an in-flight Worker when the project session is disposed', async () => {
    installFontFaceMock();
    const worker = new FakeWorker(() => undefined);
    const session = createCanvasTextPreviewFontSession({
      resource: fontResource(),
      document: fontDocumentMock().document,
      workerFactory: () => worker as unknown as Worker
    });
    const pending = session.prepareCoverage(
      Uint32Array.from([0x41]),
      new AbortController().signal
    );
    await Promise.resolve();

    session.dispose();

    await expect(pending).rejects.toMatchObject({ code: 'font_session_disposed' });
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('terminates an aborted Worker without poisoning the latest coverage request', async () => {
    installFontFaceMock();
    const fontDocument = fontDocumentMock();
    const workers: FakeWorker[] = [];
    const session = createCanvasTextPreviewFontSession({
      resource: fontResource(),
      document: fontDocument.document,
      workerFactory: () => {
        const worker = new FakeWorker(workers.length === 0 ? () => undefined : successResponse);
        workers.push(worker);
        return worker as unknown as Worker;
      }
    });
    const firstAbortController = new AbortController();
    const pending = session.prepareCoverage(
      Uint32Array.from([0x41]),
      firstAbortController.signal
    );
    await Promise.resolve();

    firstAbortController.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);
    const prepared = (await session.prepareCoverage(
      Uint32Array.from([0x42]),
      new AbortController().signal
    )).activate();

    expect(prepared.embeddedFaces).toHaveLength(1);
    expect(workers).toHaveLength(2);
    expect(fontDocument.add).toHaveBeenCalledTimes(1);
  });

  it('does not install a subset aborted while its FontFace is loading', async () => {
    const firstLoad = deferred<FontFace>();
    let loadCount = 0;
    vi.stubGlobal('FontFace', class FontFaceMock {
      constructor(
        readonly family: string,
        readonly source: ArrayBuffer,
        readonly descriptors: FontFaceDescriptors
      ) {}

      load(): Promise<FontFace> {
        loadCount += 1;
        return loadCount === 1
          ? firstLoad.promise
          : Promise.resolve(this as unknown as FontFace);
      }
    });
    const fontDocument = fontDocumentMock();
    const workers: FakeWorker[] = [];
    const session = createCanvasTextPreviewFontSession({
      resource: fontResource(),
      document: fontDocument.document,
      workerFactory: () => {
        const worker = new FakeWorker(successResponse);
        workers.push(worker);
        return worker as unknown as Worker;
      }
    });
    const abortController = new AbortController();
    const aborted = session.prepareCoverage(Uint32Array.from([0x41]), abortController.signal);
    await waitFor(() => loadCount === 1);

    abortController.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    firstLoad.resolve({} as FontFace);
    const prepared = (await session.prepareCoverage(
      Uint32Array.from([0x42]),
      new AbortController().signal
    )).activate();

    expect(prepared.embeddedFaces).toHaveLength(1);
    expect(fontDocument.add).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(2);
  });

  it('does not replace the active font until a prepared candidate is activated', async () => {
    installFontFaceMock();
    const fontDocument = fontDocumentMock();
    const session = createCanvasTextPreviewFontSession({
      resource: fontResource(),
      document: fontDocument.document,
      workerFactory: () => new FakeWorker(successResponse) as unknown as Worker
    });

    const initial = await session.prepareCoverage(
      Uint32Array.from([0x41]),
      new AbortController().signal
    );
    expect(fontDocument.add).not.toHaveBeenCalled();
    initial.activate();
    expect(fontDocument.add).toHaveBeenCalledTimes(1);

    const superseded = await session.prepareCoverage(
      Uint32Array.from([0x42]),
      new AbortController().signal
    );
    expect(fontDocument.add).toHaveBeenCalledTimes(1);
    expect(fontDocument.delete).not.toHaveBeenCalled();
    superseded.discard();

    const latest = await session.prepareCoverage(
      Uint32Array.from([0x43]),
      new AbortController().signal
    );
    latest.activate();
    expect(fontDocument.add).toHaveBeenCalledTimes(2);
    expect(fontDocument.delete).toHaveBeenCalledTimes(1);
  });
});

class FakeWorker extends EventTarget {
  readonly terminate = vi.fn();

  constructor(
    private readonly respond: (
      request: CanvasTextFontSubsetRequest
    ) => CanvasTextFontSubsetResponse | undefined
  ) {
    super();
  }

  postMessage(request: CanvasTextFontSubsetRequest): void {
    const response = this.respond(request);
    if (response) {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: response })));
    }
  }
}

function successResponse(request: CanvasTextFontSubsetRequest): CanvasTextFontSubsetResponse {
  return {
    type: 'success',
    contractVersion: 1,
    durationMs: 5,
    peakLinearMemoryBytes: 32 * 1024 * 1024,
    faces: request.faces.map((face) => ({
      family: face.family,
      weight: face.weight,
      inputBytes: 100,
      outputBytes: 1,
      durationMs: 2,
      bytes: new Uint8Array([1]).buffer
    }))
  };
}

function errorResponse(): CanvasTextFontSubsetResponse {
  return {
    type: 'error',
    contractVersion: 1,
    message: 'subset failed'
  };
}

function fontResource() {
  return createCanvasTextFontResource([{
    source: {
      url: '/font.woff2',
      read: async () => new Uint8Array([1]).buffer
    },
    sha256: 'sha256:4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a',
    weight: 400
  }]);
}

function fontDocumentMock() {
  const add = vi.fn();
  const deleteFace = vi.fn(() => true);
  return {
    document: { fonts: { add, delete: deleteFace } } as unknown as Document,
    add,
    delete: deleteFace
  };
}

function installFontFaceMock(): void {
  vi.stubGlobal('FontFace', class FontFaceMock {
    constructor(
      readonly family: string,
      readonly source: ArrayBuffer,
      readonly descriptors: FontFaceDescriptors
    ) {}

    async load(): Promise<FontFace> {
      return this as unknown as FontFace;
    }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('Condition did not settle.');
}
