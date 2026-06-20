import { describe, expect, it, vi } from 'vitest';
import {
  base64ToUint8Array,
  createCepHost,
  uint8ArrayToBase64
} from './cepHost';

describe('CEP host bridge', () => {
  it('evaluates ExtendScript and parses JSON envelopes', async () => {
    const evalScript = vi.fn((script: string, callback: (result: string) => void) => {
      expect(script).toBe('debruteBridge.hostVersion()');
      callback(JSON.stringify({ ok: true, value: '26.0.0' }));
    });
    const host = createCepHost({
      cep: { evalScript },
      fs: undefined
    });

    await expect(host.evalJson<string>('debruteBridge.hostVersion()')).resolves.toBe('26.0.0');
  });

  it('rejects failed ExtendScript envelopes', async () => {
    const host = createCepHost({
      cep: {
        evalScript(_script, callback) {
          callback(JSON.stringify({ ok: false, message: 'No document open.' }));
        }
      },
      fs: undefined
    });

    await expect(host.evalJson<string>('debruteBridge.currentSelectionSnapshot()')).rejects.toThrow('No document open.');
  });

  it('round-trips byte arrays through base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes);
  });
});
