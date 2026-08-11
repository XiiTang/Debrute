import {
  canvasTextFontDataUrl,
  canvasTextFontFaceDescriptors,
  type CanvasTextFontResource,
  type CanvasTextPreparedFont
} from '../CanvasTextRenderProfile';
import { canvasTextPreviewCoverageContains } from './CanvasTextPreviewCoverage';
import {
  CANVAS_TEXT_FONT_SUBSET_CONTRACT_VERSION,
  type CanvasTextFontSubsetRequest,
  type CanvasTextFontSubsetResponse,
  type CanvasTextFontSubsetSuccess
} from './CanvasTextFontSubsetProtocol';
import { removeCanvasTextFontFaces } from './CanvasTextFontFaces';

export interface CanvasTextPreviewFontSession {
  prepareCoverage(
    requestedCodepoints: Uint32Array,
    signal: AbortSignal
  ): Promise<CanvasTextPreviewFontPreparation>;
  dispose(): void;
}

export interface CanvasTextPreviewFontPreparation {
  activate(): CanvasTextPreparedFont;
  discard(): void;
}

export interface CanvasTextPreviewFontSubsetMetrics {
  readonly codepointCount: number;
  readonly durationMs: number;
  readonly peakLinearMemoryBytes: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly faceCount: number;
}

type CanvasTextPreviewFontSessionFailureCode =
  | 'font_source_unavailable'
  | 'font_subset_worker_failed'
  | 'font_subset_contract_mismatch'
  | 'font_subset_load_failed'
  | 'font_preparation_discarded'
  | 'font_session_disposed';

export class CanvasTextPreviewFontSessionFailure extends Error {
  readonly code: CanvasTextPreviewFontSessionFailureCode;

  constructor(code: CanvasTextPreviewFontSessionFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CanvasTextPreviewFontSessionFailure';
    this.code = code;
  }
}

interface CanvasTextPreviewFontBundle {
  readonly coverage: Uint32Array;
  readonly prepared: CanvasTextPreparedFont;
  readonly faces: readonly FontFace[];
}

export function createCanvasTextPreviewFontSession(input: {
  readonly resource: CanvasTextFontResource;
  readonly document: Document;
  readonly workerFactory?: (() => Worker) | undefined;
  readonly onSubsetMetrics?: ((metrics: CanvasTextPreviewFontSubsetMetrics) => void) | undefined;
}): CanvasTextPreviewFontSession {
  return new DefaultCanvasTextPreviewFontSession(input);
}

class DefaultCanvasTextPreviewFontSession implements CanvasTextPreviewFontSession {
  readonly #resource: CanvasTextFontResource;
  readonly #document: Document;
  readonly #workerFactory: () => Worker;
  readonly #onSubsetMetrics: ((metrics: CanvasTextPreviewFontSubsetMetrics) => void) | undefined;
  #active: CanvasTextPreviewFontBundle | undefined;
  #queue: Promise<void> = Promise.resolve();
  #terminalFailure: CanvasTextPreviewFontSessionFailure | undefined;
  #pendingPreparations = new Set<CanvasTextPreviewFontPreparation>();
  #worker: Worker | undefined;
  #rejectWorker: ((reason: unknown) => void) | undefined;
  #disposed = false;

  constructor(input: {
    readonly resource: CanvasTextFontResource;
    readonly document: Document;
    readonly workerFactory?: (() => Worker) | undefined;
    readonly onSubsetMetrics?: ((metrics: CanvasTextPreviewFontSubsetMetrics) => void) | undefined;
  }) {
    this.#resource = input.resource;
    this.#document = input.document;
    this.#workerFactory = input.workerFactory ?? (() => new Worker(
      new URL('./CanvasTextFontSubset.worker.ts', import.meta.url),
      { type: 'module', name: 'debrute-canvas-text-font-subset' }
    ));
    this.#onSubsetMetrics = input.onSubsetMetrics;
  }

  prepareCoverage(
    requestedCodepoints: Uint32Array,
    signal: AbortSignal
  ): Promise<CanvasTextPreviewFontPreparation> {
    assertCanvasTextPreviewCoverage(requestedCodepoints);
    const requested = requestedCodepoints.slice();
    return new Promise<CanvasTextPreviewFontPreparation>((resolve, reject) => {
      let settled = false;
      const finish = (result: { preparation: CanvasTextPreviewFontPreparation } | { error: unknown }) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if ('preparation' in result) {
          resolve(result.preparation);
        } else {
          reject(result.error);
        }
      };
      const onAbort = () => finish({ error: canvasTextPreviewAbortError(signal) });
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.#queue = this.#queue.then(async () => {
        if (signal.aborted) {
          return;
        }
        try {
          finish({ preparation: await this.#prepareCoverage(requested, signal) });
        } catch (error) {
          finish({ error });
        }
      });
    });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#rejectWorker?.(new CanvasTextPreviewFontSessionFailure(
      'font_session_disposed',
      'Canvas text preview font session was disposed.'
    ));
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#rejectWorker = undefined;
    for (const preparation of this.#pendingPreparations) {
      preparation.discard();
    }
    this.#pendingPreparations.clear();
    if (this.#active) {
      removeCanvasTextFontFaces(this.#document, this.#active.faces);
      this.#active = undefined;
    }
  }

  async #prepareCoverage(
    requested: Uint32Array,
    signal: AbortSignal
  ): Promise<CanvasTextPreviewFontPreparation> {
    this.#throwIfDisposed();
    throwIfCanvasTextPreviewAborted(signal);
    if (this.#active && canvasTextPreviewCoverageContains(this.#active.coverage, requested)) {
      const preparedFont = this.#active.prepared;
      return {
        activate: () => {
          this.#throwIfDisposed();
          return preparedFont;
        },
        discard: () => undefined
      };
    }
    if (this.#terminalFailure) {
      throw this.#terminalFailure;
    }
    try {
      const result = await this.#runWorker(requested, signal);
      this.#throwIfDisposed();
      throwIfCanvasTextPreviewAborted(signal);
      const candidate = await this.#createCandidate(requested, result, signal);
      this.#throwIfDisposed();
      throwIfCanvasTextPreviewAborted(signal);
      this.#onSubsetMetrics?.({
        codepointCount: requested.length,
        durationMs: result.durationMs,
        peakLinearMemoryBytes: result.peakLinearMemoryBytes,
        inputBytes: result.faces.reduce((sum, face) => sum + face.inputBytes, 0),
        outputBytes: result.faces.reduce((sum, face) => sum + face.outputBytes, 0),
        faceCount: result.faces.length
      });
      return this.#preparationForCandidate(candidate);
    } catch (error) {
      if (isCanvasTextPreviewAbortError(error)) {
        throw error;
      }
      const failure = canvasTextPreviewFontSessionFailure(error);
      if (failure.code !== 'font_session_disposed') {
        this.#terminalFailure = failure;
      }
      throw failure;
    }
  }

  #preparationForCandidate(candidate: CanvasTextPreviewFontBundle): CanvasTextPreviewFontPreparation {
    let state: 'pending' | 'active' | 'discarded' = 'pending';
    const preparation: CanvasTextPreviewFontPreparation = {
      activate: () => {
        this.#throwIfDisposed();
        if (state === 'discarded') {
          throw new CanvasTextPreviewFontSessionFailure(
            'font_preparation_discarded',
            'Canvas text preview font preparation was discarded.'
          );
        }
        if (state === 'active') {
          return candidate.prepared;
        }
        const addedFaces: FontFace[] = [];
        try {
          for (const face of candidate.faces) {
            this.#document.fonts.add(face);
            addedFaces.push(face);
          }
        } catch (error) {
          removeCanvasTextFontFaces(this.#document, addedFaces);
          const failure = new CanvasTextPreviewFontSessionFailure(
            'font_subset_load_failed',
            'Canvas text preview subset font could not be activated.',
            { cause: error }
          );
          this.#terminalFailure = failure;
          throw failure;
        }
        const previous = this.#active;
        this.#active = candidate;
        state = 'active';
        this.#pendingPreparations.delete(preparation);
        if (previous && previous !== candidate) {
          removeCanvasTextFontFaces(this.#document, previous.faces);
        }
        return candidate.prepared;
      },
      discard: () => {
        if (state !== 'pending') {
          return;
        }
        state = 'discarded';
        this.#pendingPreparations.delete(preparation);
      }
    };
    this.#pendingPreparations.add(preparation);
    return preparation;
  }

  async #runWorker(
    requested: Uint32Array,
    signal: AbortSignal
  ): Promise<CanvasTextFontSubsetSuccess> {
    throwIfCanvasTextPreviewAborted(signal);
    const faces = this.#resource.families.flatMap((family) => family.faces.map((face) => {
      if (!face.source.url) {
        throw new CanvasTextPreviewFontSessionFailure(
          'font_source_unavailable',
          `Canvas text preview font source has no Worker-readable URL (${family.identity}, ${face.weight}).`
        );
      }
      return {
        family: family.previewAlias,
        weight: face.weight,
        sourceUrl: face.source.url,
        digest: face.digest
      };
    }));
    throwIfCanvasTextPreviewAborted(signal);
    const worker = this.#workerFactory();
    this.#worker = worker;
    const requestCoverage = requested.slice();
    const request: CanvasTextFontSubsetRequest = {
      type: 'subset',
      contractVersion: CANVAS_TEXT_FONT_SUBSET_CONTRACT_VERSION,
      codepoints: requestCoverage.buffer,
      faces
    };
    try {
      return await new Promise<CanvasTextFontSubsetSuccess>((resolve, reject) => {
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) {
            return;
          }
          cleaned = true;
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
          worker.removeEventListener('messageerror', onMessageError);
          signal.removeEventListener('abort', onAbort);
          if (this.#worker === worker) {
            this.#worker = undefined;
            this.#rejectWorker = undefined;
          }
        };
        const rejectWorker = (reason: unknown) => {
          cleanup();
          reject(reason);
        };
        this.#rejectWorker = rejectWorker;
        const onMessage = (event: MessageEvent<CanvasTextFontSubsetResponse>) => {
          cleanup();
          const response = event.data;
          if (response.contractVersion !== CANVAS_TEXT_FONT_SUBSET_CONTRACT_VERSION) {
            rejectWorker(new CanvasTextPreviewFontSessionFailure(
              'font_subset_contract_mismatch',
              'Canvas text font subset Worker response contract mismatch.'
            ));
          } else if (response.type === 'error') {
            rejectWorker(new CanvasTextPreviewFontSessionFailure(
              'font_subset_worker_failed',
              response.message
            ));
          } else {
            resolve(response);
          }
        };
        const onError = (event: ErrorEvent) => {
          rejectWorker(new CanvasTextPreviewFontSessionFailure(
            'font_subset_worker_failed',
            event.message || 'Canvas text font subset Worker failed.',
            event.error === undefined ? undefined : { cause: event.error }
          ));
        };
        const onMessageError = () => {
          rejectWorker(new CanvasTextPreviewFontSessionFailure(
            'font_subset_worker_failed',
            'Canvas text font subset Worker returned an unreadable response.'
          ));
        };
        const onAbort = () => rejectWorker(canvasTextPreviewAbortError(signal));
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.addEventListener('messageerror', onMessageError);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
        worker.postMessage(request, [requestCoverage.buffer]);
      });
    } finally {
      worker.terminate();
      if (this.#worker === worker) {
        this.#worker = undefined;
        this.#rejectWorker = undefined;
      }
    }
  }

  async #createCandidate(
    coverage: Uint32Array,
    result: CanvasTextFontSubsetSuccess,
    signal: AbortSignal
  ): Promise<CanvasTextPreviewFontBundle> {
    const faces: FontFace[] = [];
    const embeddedFaces: CanvasTextPreparedFont['embeddedFaces'][number][] = [];
    try {
      for (const resultFace of result.faces) {
        throwIfCanvasTextPreviewAborted(signal);
        const bytes = resultFace.bytes;
        const descriptors = canvasTextFontFaceDescriptors({ weight: resultFace.weight });
        const face = new FontFace(resultFace.family, bytes, descriptors);
        await face.load();
        throwIfCanvasTextPreviewAborted(signal);
        const dataUrl = await canvasTextFontDataUrl(bytes);
        throwIfCanvasTextPreviewAborted(signal);
        faces.push(face);
        embeddedFaces.push({
          family: resultFace.family,
          weight: resultFace.weight,
          css: canvasTextEmbeddedFontCss(resultFace.family, resultFace.weight, dataUrl)
        });
      }
    } catch (error) {
      if (isCanvasTextPreviewAbortError(error)) {
        throw error;
      }
      throw new CanvasTextPreviewFontSessionFailure(
        'font_subset_load_failed',
        'Canvas text preview subset font could not be loaded.',
        { cause: error }
      );
    }
    return {
      coverage,
      prepared: {
        resourceIdentity: this.#resource.identity,
        embeddedFaces
      },
      faces
    };
  }

  #throwIfDisposed(): void {
    if (this.#disposed) {
      throw new CanvasTextPreviewFontSessionFailure(
        'font_session_disposed',
        'Canvas text preview font session was disposed.'
      );
    }
  }
}

function canvasTextEmbeddedFontCss(family: string, weight: string, dataUrl: string): string {
  return `@font-face{font-family:"${family}";src:url("${dataUrl}") format("woff2");font-weight:${weight};font-style:normal;font-stretch:100%;font-display:block;}`;
}

function canvasTextPreviewFontSessionFailure(error: unknown): CanvasTextPreviewFontSessionFailure {
  return error instanceof CanvasTextPreviewFontSessionFailure
    ? error
    : new CanvasTextPreviewFontSessionFailure(
        'font_subset_worker_failed',
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? { cause: error } : undefined
      );
}

function throwIfCanvasTextPreviewAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw canvasTextPreviewAbortError(signal);
  }
}

function canvasTextPreviewAbortError(signal: AbortSignal): DOMException {
  return signal.reason instanceof DOMException && signal.reason.name === 'AbortError'
    ? signal.reason
    : new DOMException('Canvas text preview font preparation was superseded.', 'AbortError');
}

function isCanvasTextPreviewAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function assertCanvasTextPreviewCoverage(codepoints: Uint32Array): void {
  if (codepoints.length === 0) {
    throw new CanvasTextPreviewFontSessionFailure(
      'font_subset_contract_mismatch',
      'Canvas text preview font coverage must not be empty.'
    );
  }
  for (let index = 0; index < codepoints.length; index += 1) {
    const codepoint = codepoints[index]!;
    if (codepoint > 0x10ffff || (index > 0 && codepoints[index - 1]! >= codepoint)) {
      throw new CanvasTextPreviewFontSessionFailure(
        'font_subset_contract_mismatch',
        'Canvas text preview font coverage must be strictly sorted unique Unicode codepoints.'
      );
    }
  }
}
