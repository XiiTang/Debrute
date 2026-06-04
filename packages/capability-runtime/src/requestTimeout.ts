export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export interface RequestTimeoutSignal {
  signal: AbortSignal;
  timeoutMs: number;
  timedOut: () => boolean;
  dispose: () => void;
}

export type RequestTimeoutFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface RequestTimeoutOptions {
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  timeoutMessage?: string | undefined;
  abortMessage?: string | undefined;
}

export function parseRequestTimeoutMs(value: unknown, defaultMs = DEFAULT_REQUEST_TIMEOUT_MS): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true, value: defaultMs };
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { ok: false, message: 'timeoutMs must be a positive integer.' };
  }
  return { ok: true, value };
}

export function createRequestTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number, timeoutMessage?: string): RequestTimeoutSignal {
  const controller = new AbortController();
  let timedOut = false;
  const parentAbort = () => controller.abort(parent?.reason ?? new DOMException('Aborted', 'AbortError'));
  if (parent?.aborted) {
    parentAbort();
  } else {
    parent?.addEventListener('abort', parentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(timeoutMessage ?? `Request timed out after ${timeoutMs}ms.`, 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timeoutMs,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', parentAbort);
    }
  };
}

export function isRequestTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

export async function fetchWithRequestTimeout(
  fetchImpl: RequestTimeoutFetch,
  url: string,
  init: RequestInit,
  options: RequestTimeoutOptions
): Promise<Response> {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error(options.abortMessage ?? 'Request aborted.');
  }
  const timeout = createRequestTimeoutSignal(options.signal, options.timeoutMs, options.timeoutMessage);
  try {
    return await fetchImpl(url, { ...init, signal: timeout.signal });
  } finally {
    timeout.dispose();
  }
}

export async function readResponseTextWithTimeout(response: Response, options: RequestTimeoutOptions): Promise<string> {
  return new TextDecoder().decode(await readResponseBytesWithTimeout(response, options));
}

export async function readResponseArrayBufferWithTimeout(response: Response, options: RequestTimeoutOptions): Promise<ArrayBuffer> {
  return arrayBufferFor(await readResponseBytesWithTimeout(response, options));
}

async function readResponseBytesWithTimeout(response: Response, options: RequestTimeoutOptions): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  let settled = false;

  return await new Promise<Uint8Array>((resolve, reject) => {
    const timeout = createRequestTimeoutSignal(options.signal, options.timeoutMs, options.timeoutMessage);
    const cleanup = () => {
      timeout.signal.removeEventListener('abort', onAbort);
      timeout.dispose();
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      void reader.cancel().catch(() => undefined);
      reject(error);
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(concatBytes(chunks, totalLength));
    };
    const onAbort = () => fail(timeout.signal.reason ?? new Error(options.abortMessage ?? 'Request aborted.'));

    if (timeout.signal.aborted) {
      onAbort();
      return;
    }
    timeout.signal.addEventListener('abort', onAbort, { once: true });

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            chunks.push(value);
            totalLength += value.byteLength;
          }
        }
        succeed();
      } catch (error) {
        fail(error);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // The reader may already be released after cancellation.
        }
      }
    };
    void pump();
  });
}

function concatBytes(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function arrayBufferFor(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
