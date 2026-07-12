import { describe, expect, it } from 'vitest';

import { pcmFromMimeType } from './artifacts.js';

describe('audio model artifacts', () => {
  it('parses explicit PCM MIME parameters without synthesizing model defaults', () => {
    expect(pcmFromMimeType('audio/L16;codec=pcm;rate=24000;channels=2')).toEqual({
      sampleRate: 24000,
      channels: 2,
      bitsPerSample: 16
    });
    expect(pcmFromMimeType('audio/pcm;rate=48000;channels=1;bits=24')).toEqual({
      sampleRate: 48000,
      channels: 1,
      bitsPerSample: 24
    });
    expect(pcmFromMimeType('audio/L16;codec=pcm;rate=24000')).toBeUndefined();
    expect(pcmFromMimeType('audio/pcm')).toBeUndefined();
  });
});
