import type { IpcMain } from 'electron';

export type IpcPrimitive = string | number | boolean | null;

export interface IpcErrorPayload {
  code: string;
  message: string;
  fields?: Record<string, IpcPrimitive>;
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: IpcErrorPayload };

export class IpcBridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly fields?: Record<string, IpcPrimitive>
  ) {
    super(message);
    this.name = 'IpcBridgeError';
  }
}

export function serializeIpcError(error: unknown): IpcErrorPayload {
  const message = error instanceof Error ? error.message : String(error);
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'internal_error';
  const fields = isRecord(error) && isRecord(error.fields) ? primitiveFields(error.fields) : {};
  return {
    code,
    message,
    ...(Object.keys(fields).length > 0 ? { fields } : {})
  };
}

export function deserializeIpcError(payload: IpcErrorPayload): IpcBridgeError {
  return new IpcBridgeError(payload.message, payload.code, payload.fields);
}

export function unwrapIpcResult<T>(result: IpcResult<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw deserializeIpcError(result.error);
}

export function createSafeIpcHandler<Args extends unknown[], Result>(
  handler: (...args: Args) => Result | Promise<Result>
): (...args: Args) => Promise<IpcResult<Awaited<Result>>> {
  return async (...args) => {
    try {
      return {
        ok: true,
        value: await handler(...args)
      };
    } catch (error) {
      return {
        ok: false,
        error: serializeIpcError(error)
      };
    }
  };
}

export function registerSafeIpcHandler<Args extends unknown[], Result>(
  ipcMain: IpcMain,
  channel: string,
  handler: (...args: Args) => Result | Promise<Result>
): void {
  const safeHandler = createSafeIpcHandler(handler);
  ipcMain.handle(channel, (_event, ...args: Args) => safeHandler(...args));
}

function primitiveFields(fields: Record<string, unknown>): Record<string, IpcPrimitive> {
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, IpcPrimitive] => isPrimitive(entry[1])));
}

function isPrimitive(value: unknown): value is IpcPrimitive {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
