import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCepPhotoshopBridgeIdentityStore } from './identityStore';

describe('CEP Photoshop Bridge identity store', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stores the private identity only below the extension-scoped Adobe user-data directory', async () => {
    const makedir = vi.fn(() => ({ err: 0 }));
    const writeFile = vi.fn(() => ({ err: 0 }));
    const readFile = vi.fn(() => ({ err: 0, data: '{"identity":true}' }));
    vi.stubGlobal('window', {
      __adobe_cep__: {
        getSystemPath: () => '/Users/test/Adobe/User Data'
      },
      cep: {
        encoding: { Base64: 'base64', UTF8: 'utf8' },
        fs: { NO_ERROR: 0, makedir, readFile, writeFile, deleteFile: vi.fn() }
      }
    });

    const store = createCepPhotoshopBridgeIdentityStore();
    await expect(store.read()).resolves.toBe('{"identity":true}');
    await store.write('{"privateKey":"secret"}');

    const directory = '/Users/test/Adobe/User Data/com.debrute.photoshop.bridge';
    expect(makedir).toHaveBeenCalledWith(directory);
    expect(readFile).toHaveBeenCalledWith(`${directory}/debrute-photoshop-bridge-identity-v1.json`, 'utf8');
    expect(writeFile).toHaveBeenCalledWith(
      `${directory}/debrute-photoshop-bridge-identity-v1.json`,
      '{"privateKey":"secret"}',
      'utf8'
    );
  });
});
