import { describe, expect, it } from 'vitest';
import {
  RuntimeControlError,
  type RuntimeControlClient
} from '@debrute/runtime-control-client';
import {
  macosRuntimeApplicationNeedsAssembly,
  stopRustRuntime
} from '../../scripts/rust-runtime-dev.js';

describe('macOS Runtime development application assembly', () => {
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
