import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RuntimeControlError,
  type RuntimeControlClient
} from '@debrute/runtime-control-client';
import {
  isWindowsRuntimeReplacementRetryableError,
  macosRuntimeApplicationNeedsAssembly,
  parseWindowsRuntimeAssemblyIdentity,
  retryWindowsRuntimeReplacementOperation,
  runtimeExecutableNeedsAssembly,
  stopRustRuntime,
  windowsRuntimeDirectoryInventorySha256,
  windowsRuntimeDirectoryNeedsAssembly
} from '../../scripts/rust-runtime-dev.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

describe('macOS Runtime development application assembly', () => {
  it('shares the closed Runtime executable assembly rule', () => {
    expect(runtimeExecutableNeedsAssembly({
      compiledRuntimeIdentity: 'current-runtime',
      installedRuntimeIdentity: 'current-runtime',
      runtimeExecutableExists: true
    })).toBe(false);
    expect(runtimeExecutableNeedsAssembly({
      compiledRuntimeIdentity: 'current-runtime',
      installedRuntimeIdentity: 'current-runtime',
      runtimeExecutableExists: false
    })).toBe(true);
  });

  it('reassembles when the installed application was not built from the current Runtime binary', () => {
    expect(macosRuntimeApplicationNeedsAssembly({
      compiledRuntimeIdentity: 'new-runtime',
      installedRuntimeIdentity: 'old-runtime',
      runtimeExecutableExists: true
    })).toBe(true);
    expect(macosRuntimeApplicationNeedsAssembly({
      compiledRuntimeIdentity: 'new-runtime',
      installedRuntimeIdentity: undefined,
      runtimeExecutableExists: true
    })).toBe(true);
  });

  it('reuses an installed application recorded for the current Runtime binary', () => {
    expect(macosRuntimeApplicationNeedsAssembly({
      compiledRuntimeIdentity: 'current-runtime',
      installedRuntimeIdentity: 'current-runtime',
      runtimeExecutableExists: true
    })).toBe(false);
  });

  it('accepts Runtime loss only when it is observed during the stop request', async () => {
    let runtimeLost: ((error: RuntimeControlError) => void) | undefined;
    let unsubscribed = false;
    const control = {
      onRuntimeLost(listener: (error: RuntimeControlError) => void) {
        runtimeLost = listener;
        return () => {
          unsubscribed = true;
        };
      },
      async quitProduct() {
        const error = new RuntimeControlError('runtime_lost', 'fixture Runtime exited');
        runtimeLost?.(error);
        throw error;
      }
    } as unknown as RuntimeControlClient;

    await expect(stopRustRuntime(control)).resolves.toBeUndefined();
    expect(unsubscribed).toBe(true);
  });

  it('rejects Runtime loss that was not observed during the stop request', async () => {
    let unsubscribed = false;
    const control = {
      onRuntimeLost() {
        return () => {
          unsubscribed = true;
        };
      },
      async quitProduct() {
        throw new RuntimeControlError('runtime_lost', 'unobserved fixture loss');
      }
    } as unknown as RuntimeControlClient;

    await expect(stopRustRuntime(control)).rejects.toMatchObject({ code: 'runtime_lost' });
    expect(unsubscribed).toBe(true);
  });
});

describe('Windows Runtime development directory assembly', () => {
  const expectation = {
    compiledRuntimeIdentity: 'current-runtime',
    compiledRuntimeSha256: SHA_A,
    nativeRasterManifestSha256: SHA_B,
    nativeRasterRuntimeInventorySha256: SHA_C,
    runtimePayloadInventorySha256: SHA_D
  };
  const installedIdentity = { schemaVersion: 3 as const, ...expectation };

  it('reuses only an exact executable, payload manifest, and Runtime inventory', () => {
    expect(windowsRuntimeDirectoryNeedsAssembly({
      expectation,
      installedIdentity,
      installedRuntimeSha256: SHA_A,
      installedRuntimeInventorySha256: SHA_D
    })).toBe(false);

    for (const changed of [
      { installedIdentity: { ...installedIdentity, compiledRuntimeIdentity: 'old-runtime' } },
      { installedIdentity: { ...installedIdentity, compiledRuntimeSha256: SHA_B } },
      { installedIdentity: { ...installedIdentity, nativeRasterManifestSha256: SHA_C } },
      { installedIdentity: { ...installedIdentity, nativeRasterRuntimeInventorySha256: SHA_B } },
      { installedIdentity: { ...installedIdentity, runtimePayloadInventorySha256: SHA_C } },
      { installedRuntimeSha256: SHA_B },
      { installedRuntimeInventorySha256: SHA_B },
      { installedIdentity: undefined },
      { installedRuntimeSha256: undefined },
      { installedRuntimeInventorySha256: undefined }
    ]) {
      expect(windowsRuntimeDirectoryNeedsAssembly({
        expectation,
        installedIdentity,
        installedRuntimeSha256: SHA_A,
        installedRuntimeInventorySha256: SHA_D,
        ...changed
      })).toBe(true);
    }
  });

  it('accepts only the current closed assembly identity shape', () => {
    const serialized = JSON.stringify(installedIdentity);
    expect(parseWindowsRuntimeAssemblyIdentity(serialized)).toEqual(installedIdentity);
    expect(parseWindowsRuntimeAssemblyIdentity('current-runtime')).toBeUndefined();
    expect(parseWindowsRuntimeAssemblyIdentity(JSON.stringify({
      ...installedIdentity,
      extra: true
    }))).toBeUndefined();
    expect(parseWindowsRuntimeAssemblyIdentity(JSON.stringify({
      ...installedIdentity,
      compiledRuntimeSha256: 'not-a-sha256'
    }))).toBeUndefined();
  });

  it('hashes the complete flat payload inventory by file name, size, and content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-runtime-inventory-'));
    try {
      writeFileSync(join(root, 'debrute-runtime.exe'), 'runtime');
      writeFileSync(join(root, 'libvips-42.dll'), 'vips');
      writeFileSync(join(root, 'LICENSE'), 'license');
      const initial = await windowsRuntimeDirectoryInventorySha256(root);
      const expectedInventory = [
        inventoryEntry('LICENSE', 'license'),
        inventoryEntry('libvips-42.dll', 'vips')
      ].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      const expected = createHash('sha256').update(JSON.stringify(expectedInventory)).digest('hex');
      expect(initial).toBe(expected);

      writeFileSync(join(root, 'libvips-42.dll'), 'VIPS');
      expect(await windowsRuntimeDirectoryInventorySha256(root)).not.toBe(initial);

      writeFileSync(join(root, 'unexpected.dll'), 'unexpected');
      expect(await windowsRuntimeDirectoryInventorySha256(root)).not.toBe(initial);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries only the bounded Windows filesystem contention errors', () => {
    for (const code of ['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']) {
      expect(isWindowsRuntimeReplacementRetryableError(systemError(code))).toBe(true);
    }
    for (const value of [
      systemError('EACCES'),
      systemError('EEXIST'),
      systemError('ENOENT'),
      new Error('missing code'),
      null,
      'EPERM'
    ]) {
      expect(isWindowsRuntimeReplacementRetryableError(value)).toBe(false);
    }
  });

  it('waits through transient Windows Runtime replacement locks', async () => {
    const locked = systemError('EPERM');
    let attempts = 0;

    await expect(retryWindowsRuntimeReplacementOperation(
      'replace the fixture Runtime directory',
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw locked;
        }
      },
      Date.now() + 1_000
    )).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });

  it('fails immediately for non-lock errors and retains the final lock error at the deadline', async () => {
    const permissionDenied = systemError('EACCES');
    let permissionAttempts = 0;
    await expect(retryWindowsRuntimeReplacementOperation(
      'replace the fixture Runtime directory',
      async () => {
        permissionAttempts += 1;
        throw permissionDenied;
      },
      Date.now() + 1_000
    )).rejects.toBe(permissionDenied);
    expect(permissionAttempts).toBe(1);

    const locked = systemError('EBUSY');
    let deadlineError: unknown;
    try {
      await retryWindowsRuntimeReplacementOperation(
        'replace the fixture Runtime directory',
        async () => {
          throw locked;
        },
        Date.now()
      );
    } catch (error) {
      deadlineError = error;
    }
    expect(deadlineError).toBeInstanceOf(Error);
    expect((deadlineError as Error).message).toBe(
      'Windows Runtime development assembly could not replace the fixture Runtime directory before locked files were released.'
    );
    expect((deadlineError as Error).cause).toBe(locked);
  });
});

function inventoryEntry(name: string, contents: string): {
  name: string;
  sizeBytes: number;
  sha256: string;
} {
  return {
    name,
    sizeBytes: Buffer.byteLength(contents),
    sha256: createHash('sha256').update(contents).digest('hex')
  };
}

function systemError(code: string): Error & { code: string } {
  return Object.assign(new Error(`fixture ${code}`), { code });
}
