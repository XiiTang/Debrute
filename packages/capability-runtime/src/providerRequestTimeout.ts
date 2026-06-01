export const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 120_000;

export interface ProviderRequestTimeoutSignal {
  signal: AbortSignal;
  timeoutMs: number;
  timedOut: () => boolean;
  dispose: () => void;
}

export function parseProviderRequestTimeoutMs(value: unknown, defaultMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true, value: defaultMs };
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { ok: false, message: 'timeoutMs must be a positive integer.' };
  }
  return { ok: true, value };
}

export function createProviderRequestTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): ProviderRequestTimeoutSignal {
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
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms.`, 'TimeoutError'));
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

export function isProviderRequestTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}
