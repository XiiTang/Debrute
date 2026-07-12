export const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQAHSQGmK3P7WAAAAABJRU5ErkJggg==';
export const tinyMp3Hex = '49443303000000000000';
export const tinyMp4Hex = '00000018667479706d703432000000006d70343269736f6d';
export const tinyWavHex = '524946460000000057415645666d7420';

export function tinyPngBytes(): Buffer<ArrayBuffer> {
  return Buffer.from(tinyPngBase64, 'base64');
}

export function tinyMp3Bytes(): Buffer<ArrayBuffer> {
  return Buffer.from(tinyMp3Hex, 'hex');
}

export function tinyMp4Bytes(): Buffer<ArrayBuffer> {
  return Buffer.from(tinyMp4Hex, 'hex');
}

export function tinyWavBytes(): Buffer<ArrayBuffer> {
  return Buffer.from(tinyWavHex, 'hex');
}
