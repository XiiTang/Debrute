import { inflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { encodeRgbaPng } from './pngEncoder.js';

describe('encodeRgbaPng', () => {
  it('encodes exact RGBA scanlines including transparency', () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255,
      0, 0, 0, 0,
      0, 255, 0, 128,
      0, 0, 255, 255
    ]);
    const png = encodeRgbaPng(rgba, 2, 2);

    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const idat = readChunk(png, 'IDAT');
    expect([...inflateSync(idat)]).toEqual([
      0, 255, 0, 0, 255, 0, 0, 0, 0,
      0, 0, 255, 0, 128, 0, 0, 255, 255
    ]);
  });

  it('rejects mismatched dimensions', () => {
    expect(() => encodeRgbaPng(new Uint8Array(3), 1, 1)).toThrow('does not match');
  });

  it('encodes PNG chunk names without the browser-only TextEncoder global', () => {
    vi.stubGlobal('TextEncoder', undefined);
    try {
      const png = encodeRgbaPng(new Uint8Array([1, 2, 3, 4]), 1, 1);
      expect([...png.subarray(12, 16)]).toEqual([73, 72, 68, 82]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function readChunk(png: Uint8Array, targetType: string): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  while (offset < png.byteLength) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    if (type === targetType) return png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
  }
  throw new Error(`Missing ${targetType} chunk.`);
}
