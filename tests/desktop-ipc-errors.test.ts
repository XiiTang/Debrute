import { describe, expect, it } from 'vitest';
import {
  createSafeIpcHandler,
  deserializeIpcError,
  serializeIpcError,
  unwrapIpcResult
} from '../apps/desktop/src/electron/ipc/ipcErrors';

describe('Desktop IPC errors', () => {
  it('serializes service errors into preload-safe payloads', () => {
    const error = Object.assign(new Error('Flowmap failed'), {
      code: 'flowmap_invalid',
      fields: {
        file_path: '.axis/flowmaps/main.draft.yaml',
        line: 4,
        nested: { ignored: true }
      }
    });

    expect(serializeIpcError(error)).toEqual({
      code: 'flowmap_invalid',
      message: 'Flowmap failed',
      fields: {
        file_path: '.axis/flowmaps/main.draft.yaml',
        line: 4
      }
    });
  });

  it('wraps IPC handlers in an explicit result envelope', async () => {
    await expect(createSafeIpcHandler(async () => ({ ok: true }))()).resolves.toEqual({
      ok: true,
      value: { ok: true }
    });
    await expect(createSafeIpcHandler(async () => {
      throw Object.assign(new Error('Project missing'), { code: 'project_not_found' });
    })()).resolves.toEqual({
      ok: false,
      error: {
        code: 'project_not_found',
        message: 'Project missing'
      }
    });
  });

  it('restores serialized errors at the preload boundary', () => {
    const error = deserializeIpcError({
      code: 'project_not_found',
      message: 'Project missing',
      fields: { project_root: '/tmp/project' }
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Project missing');
    expect(error.code).toBe('project_not_found');
    expect(error.fields).toEqual({ project_root: '/tmp/project' });

    expect(() => unwrapIpcResult({
      ok: false,
      error: {
        code: 'project_not_found',
        message: 'Project missing',
        fields: { project_root: '/tmp/project' }
      }
    })).toThrow('Project missing');
  });
});
