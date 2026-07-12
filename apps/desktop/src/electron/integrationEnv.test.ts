import { describe, expect, it } from 'vitest';
import { resolveDesktopIntegrationEnvPath } from './integrationEnv.js';

describe('desktop integration environment', () => {
  it('adds Homebrew locations to the macOS desktop PATH used for integration probes', () => {
    const envPath = resolveDesktopIntegrationEnvPath({
      platform: 'darwin',
      envPath: '/usr/bin:/bin'
    });

    expect(envPath.split(':')).toEqual([
      '/usr/bin',
      '/bin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin'
    ]);
  });

  it('leaves non-macOS PATH entries unchanged', () => {
    expect(resolveDesktopIntegrationEnvPath({
      platform: 'linux',
      envPath: '/usr/bin:/bin'
    })).toBe('/usr/bin:/bin');
  });

});
