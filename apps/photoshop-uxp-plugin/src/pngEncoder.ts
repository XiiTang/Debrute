import { zlibSync } from 'fflate';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = buildCrcTable();

export function encodeRgbaPng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error('PNG dimensions must be positive integers.');
  }
  const rowBytes = width * 4;
  if (rgba.byteLength !== rowBytes * height) {
    throw new Error('PNG RGBA buffer does not match its dimensions.');
  }
  const scanlines = new Uint8Array((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const targetOffset = row * (rowBytes + 1);
    scanlines[targetOffset] = 0;
    scanlines.set(rgba.subarray(row * rowBytes, (row + 1) * rowBytes), targetOffset + 1);
  }
  return concatenate([
    PNG_SIGNATURE,
    pngChunk('IHDR', imageHeader(width, height)),
    pngChunk('IDAT', zlibSync(scanlines, { level: 6 })),
    pngChunk('IEND', new Uint8Array())
  ]);
}

function imageHeader(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  return header;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = asciiChunkType(type);
  const result = new Uint8Array(12 + data.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.byteLength);
  result.set(typeBytes, 4);
  result.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(result.subarray(4, 8 + data.byteLength)));
  return result;
}

function asciiChunkType(type: string): Uint8Array {
  if (type.length !== 4) throw new Error('PNG chunk types must contain four ASCII characters.');
  const bytes = new Uint8Array(4);
  for (let index = 0; index < type.length; index += 1) {
    const value = type.charCodeAt(index);
    if (value > 0x7f) throw new Error('PNG chunk types must contain four ASCII characters.');
    bytes[index] = value;
  }
  return bytes;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
