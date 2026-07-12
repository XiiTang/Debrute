import { describe, expect, it } from 'vitest';

import { createAudioModelCatalog } from './catalog.js';

describe('audio model catalog', () => {
  it('defines TTS, music, and sound-effect model catalogs separately', () => {
    const catalog = createAudioModelCatalog();

    expect(catalog.listByKind('tts').map((model) => model.debruteModelId)).toEqual([
      'dashscope-qwen3-tts-flash',
      'doubao-seed-tts-2-0',
      'elevenlabs-multilingual-v2',
      'elevenlabs-v3-tts',
      'gemini-tts',
      'minimax-speech-2-8-hd',
      'openai-gpt-4o-mini-tts',
      'openai-tts-1',
      'openai-tts-1-hd'
    ]);
    expect(catalog.listByKind('music').map((model) => model.debruteModelId)).toEqual([
      'elevenlabs-music',
      'fal-stable-audio-text-to-audio',
      'google-lyria-3-clip-preview',
      'google-lyria-3-pro-preview',
      'minimax-music-2-6'
    ]);
    expect(catalog.listByKind('sound-effect').map((model) => model.debruteModelId)).toEqual([
      'elevenlabs-sound-effects',
      'fal-stable-audio-sfx'
    ]);

    expect(catalog.get('openai-gpt-4o-mini-tts')).toMatchObject({
      kind: 'tts',
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultRequestModelId: 'gpt-4o-mini-tts',
      listParameters: expect.objectContaining({
        text: expect.stringContaining('required'),
        voice: expect.stringContaining('voice')
      })
    });
    expect(catalog.get('elevenlabs-music')).toMatchObject({
      kind: 'music',
      listParameters: expect.objectContaining({ prompt: expect.stringContaining('required') })
    });
    expect(catalog.get('elevenlabs-sound-effects')).toMatchObject({
      kind: 'sound-effect',
      listParameters: expect.objectContaining({ prompt: expect.stringContaining('required') })
    });
    expect((catalog.get('dashscope-qwen3-tts-flash')?.argumentsSchema.properties as Record<string, unknown>).format)
      .toBeUndefined();
    expect((catalog.get('google-lyria-3-clip-preview')?.argumentsSchema.properties as Record<string, unknown>).format)
      .toBeUndefined();
    expect((catalog.get('google-lyria-3-pro-preview')?.argumentsSchema.properties as Record<string, unknown>).format)
      .toEqual({ type: 'string', enum: ['mp3', 'wav'] });
    expect(catalog.get('elevenlabs-v3-tts')?.listParameters).toHaveProperty('voice_id');
    expect(catalog.get('elevenlabs-v3-tts')?.listParameters).not.toHaveProperty('voice');
    expect(catalog.get('elevenlabs-v3-tts')?.argumentsSchema.required).toEqual(['text', 'voice_id']);
    expect(catalog.get('elevenlabs-music')?.listParameters).not.toHaveProperty('lyrics');
    expect(catalog.get('elevenlabs-music')?.argumentsSchema.properties as Record<string, unknown>).not.toHaveProperty('lyrics');
    expect(JSON.stringify(catalog.listAll().map((model) => model.argumentsSchema))).not.toContain('"additionalProperties":true');
  });

  it('keeps list parameter roots present in each audio model argument schema', () => {
    const catalog = createAudioModelCatalog();

    for (const model of catalog.listAll()) {
      const properties = model.argumentsSchema.properties as Record<string, unknown>;
      const schemaKeys = new Set(Object.keys(properties));
      const missing = Object.keys(model.listParameters)
        .map((key) => key.split('.')[0]!)
        .filter((key, index, keys) => !schemaKeys.has(key) && keys.indexOf(key) === index);

      expect(missing, model.debruteModelId).toEqual([]);
    }
  });

});
