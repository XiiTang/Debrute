import { describe, expect, it } from 'vitest';
import { macosRuntimeApplicationNeedsAssembly } from '../../scripts/rust-runtime-dev.js';

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
});
