import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAudioModelCatalog,
  executeAudioModelRequest,
  pcmFromMimeType,
  type AudioModelFetch
} from '@debrute/capability-runtime';

const tinyMp3 = Buffer.from('49443303000000000000', 'hex');

describe('audio model catalog and executor', () => {
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

  it('runs a configured OpenAI TTS request and records a tts-audio artifact', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-openai-tts-'));
    const recorded: unknown[] = [];
    const fetch: AudioModelFetch = async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/audio/speech');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer sk-audio' });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-4o-mini-tts',
        input: 'Read this line.',
        voice: 'alloy',
        response_format: 'mp3'
      });
      return new Response(tinyMp3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    };
    try {
      const result = await executeAudioModelRequest({
        projectRoot,
        invocationId: 'turn-audio',
        requestedKind: 'tts',
        input: {
          model: 'openai-gpt-4o-mini-tts',
          arguments: {
            text: 'Read this line.',
            voice: 'alloy',
            format: 'mp3',
            output_path: 'generated/read-this-line.mp3'
          }
        },
        settings: {
          audioModels: [{
            debruteModelId: 'openai-gpt-4o-mini-tts',
            baseUrlOverride: null,
            requestModelIdOverride: null
          }]
        },
        secrets: { audioModelApiKeys: { 'openai-gpt-4o-mini-tts': [{ id: 'aud-a', key: 'sk-audio', label: null, enabled: true }] } },
        fetch,
        recordGeneratedAsset: async (input) => {
          recorded.push(input);
        }
      });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') {
        throw new Error(result.content);
      }
      expect(result.artifacts).toEqual([expect.objectContaining({
        projectRelativePath: 'generated/read-this-line.mp3',
        mimeType: 'audio/mpeg'
      })]);
      await expect(readFile(join(projectRoot, 'generated/read-this-line.mp3'))).resolves.toEqual(tinyMp3);
      expect(recorded).toEqual([expect.objectContaining({
        projectRelativePath: 'generated/read-this-line.mp3',
        artifactRole: 'tts-audio',
        artifactIndex: 0
      })]);
      expect(JSON.stringify(result.logs)).not.toContain('sk-audio');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rotates enabled API keys for consecutive audio requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-key-rotation-'));
    const seenAuth: string[] = [];
    const fetch: AudioModelFetch = async (_url, init) => {
      seenAuth.push(String((init?.headers as Record<string, string>).authorization));
      return new Response(tinyMp3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    };
    try {
      const baseInput = {
        projectRoot,
        invocationId: 'turn-audio',
        requestedKind: 'tts',
        input: {
          model: 'openai-gpt-4o-mini-tts',
          arguments: {
            text: 'Read this line.',
            voice: 'alloy',
            format: 'mp3'
          }
        },
        settings: {
          audioModels: [{ debruteModelId: 'openai-gpt-4o-mini-tts', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: {
          audioModelApiKeys: {
            'openai-gpt-4o-mini-tts': [
              { id: 'aud-a', key: 'sk-audio-a', label: null, enabled: true },
              { id: 'aud-b', key: 'sk-audio-b', label: null, enabled: true }
            ]
          }
        },
        fetch
      } satisfies Parameters<typeof executeAudioModelRequest>[0];

      await executeAudioModelRequest(baseInput);
      await executeAudioModelRequest({ ...baseInput, invocationId: 'turn-audio-2' });

      expect(seenAuth).toEqual(['Bearer sk-audio-a', 'Bearer sk-audio-b']);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('wraps OpenAI PCM bytes as a WAV artifact', async () => {
    const run = await runAudioModelForTest({
      model: 'openai-gpt-4o-mini-tts',
      requestedKind: 'tts',
      args: {
        text: 'Read this line.',
        voice: 'alloy',
        format: 'pcm',
        output_path: 'generated/openai.wav'
      },
      responses: [{
        headers: { 'content-type': 'audio/pcm' },
        bytes: new Uint8Array([0x01, 0x02, 0x03, 0x04])
      }]
    });

    try {
      expect(run.result.status).toBe('ok');
      if (run.result.status !== 'ok') {
        throw new Error(run.result.content);
      }
      const artifact = run.result.artifacts[0]!;
      const bytes = await readFile(join(run.projectRoot, artifact.projectRelativePath));
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect(artifact.mimeType).toBe('audio/wav');
    } finally {
      await run.cleanup();
    }
  });

  it('redacts audio API keys from upstream JSON failure messages while preserving response structure', async () => {
    const run = await runAudioModelForTest({
      model: 'gemini-tts',
      requestedKind: 'tts',
      args: { text: 'Read this line.' },
      responses: [{
        status: 401,
        body: {
          error: {
            message: 'provider echoed sk-audio-secret',
            code: 'auth_failed'
          }
        }
      }],
      apiKey: 'sk-audio-secret'
    });

    try {
      expect(run.result).toMatchObject({
        status: 'error',
        error: 'audio_request_failed'
      });
      expect(run.result.content).toContain('Gemini TTS request failed: 401');
      expect(run.result.content).toContain('provider echoed [redacted]');
      expect(run.result.content).toContain('auth_failed');
      expect(run.result.content).not.toContain('sk-audio-secret');
      expect(JSON.stringify(run.result.logs)).not.toContain('sk-audio-secret');
    } finally {
      await run.cleanup();
    }
  });

  it('runs shared adapters through each remaining catalog model id', async () => {
    const cases: Array<{
      model: string;
      requestedKind: 'tts' | 'music';
      args: Record<string, unknown>;
      responses: Array<{ status?: number; headers?: Record<string, string>; body?: unknown; bytes?: Uint8Array }>;
      assertRequest: (requests: Array<{ url: string; init?: RequestInit }>) => void;
    }> = [
      {
        model: 'openai-tts-1',
        requestedKind: 'tts',
        args: { text: 'Read this line.', output_path: 'generated/openai-tts-1.mp3' },
        responses: [{ headers: { 'content-type': 'audio/mpeg' }, bytes: tinyMp3 }],
        assertRequest: (requests) => {
          expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({ model: 'tts-1' });
        }
      },
      {
        model: 'openai-tts-1-hd',
        requestedKind: 'tts',
        args: { text: 'Read this line.', output_path: 'generated/openai-tts-1-hd.mp3' },
        responses: [{ headers: { 'content-type': 'audio/mpeg' }, bytes: tinyMp3 }],
        assertRequest: (requests) => {
          expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({ model: 'tts-1-hd' });
        }
      },
      {
        model: 'elevenlabs-v3-tts',
        requestedKind: 'tts',
        args: { text: 'Read this line.', voice_id: 'JBFqnCBsd6RMkjVDRZzb', output_path: 'generated/eleven-v3.mp3' },
        responses: [{ headers: { 'content-type': 'audio/mpeg' }, bytes: tinyMp3 }],
        assertRequest: (requests) => {
          expect(requests[0]!.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128');
          expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({ model_id: 'eleven_v3' });
        }
      },
      {
        model: 'elevenlabs-multilingual-v2',
        requestedKind: 'tts',
        args: { text: 'Read this line.', voice_id: 'JBFqnCBsd6RMkjVDRZzb', output_path: 'generated/eleven-multilingual.mp3' },
        responses: [{ headers: { 'content-type': 'audio/mpeg' }, bytes: tinyMp3 }],
        assertRequest: (requests) => {
          expect(requests[0]!.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128');
          expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({ model_id: 'eleven_multilingual_v2' });
        }
      },
      {
        model: 'google-lyria-3-clip-preview',
        requestedKind: 'music',
        args: { prompt: 'Bright synth pop loop.', output_path: 'generated/lyria-clip.mp3' },
        responses: [{
          body: googleInteractionAudioResponse(tinyMp3.toString('base64'), 'audio/mpeg')
        }],
        assertRequest: (requests) => {
          expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
            model: 'lyria-3-clip-preview',
            input: 'Bright synth pop loop.'
          });
        }
      }
    ];

    for (const item of cases) {
      const run = await runAudioModelForTest(item);
      try {
        expect(run.result.status, item.model).toBe('ok');
        if (run.result.status !== 'ok') {
          throw new Error(run.result.content);
        }
        item.assertRequest(run.requests);
      } finally {
        await run.cleanup();
      }
    }
  });

  it('writes MiniMax TTS hex audio bytes exactly', async () => {
    const run = await runAudioModelForTest({
      model: 'minimax-speech-2-8-hd',
      requestedKind: 'tts',
      args: {
        text: 'Read this line.',
        output_path: 'generated/minimax.mp3'
      },
      responses: [{
        body: {
          data: {
            audio: '010203',
            audio_format: 'mp3'
          },
          trace_id: 'trace-minimax-tts'
        }
      }]
    });

    try {
      expect(run.result.status).toBe('ok');
      if (run.result.status !== 'ok') {
        throw new Error(run.result.content);
      }

      const artifact = run.result.artifacts[0]!;
      const bytes = await readFile(join(run.projectRoot, artifact.projectRelativePath));

      expect(Buffer.from(bytes).toString('hex')).toBe('010203');
      expect(artifact.mimeType).toBe('audio/mpeg');
    } finally {
      await run.cleanup();
    }
  });

  it('writes MiniMax music hex audio bytes exactly', async () => {
    const run = await runAudioModelForTest({
      model: 'minimax-music-2-6',
      requestedKind: 'music',
      args: {
        prompt: 'Bright product loop.',
        instrumental: true,
        output_path: 'generated/minimax-music.mp3'
      },
      responses: [{
        body: {
          data: {
            audio: '010203',
            status: 2
          },
          extra_info: {
            music_sample_rate: 44100,
            music_channel: 2
          },
          trace_id: 'trace-minimax-music'
        }
      }]
    });

    try {
      expect(run.result.status).toBe('ok');
      if (run.result.status !== 'ok') {
        throw new Error(run.result.content);
      }
      expect(JSON.parse(String(run.requests[0]!.init?.body))).toMatchObject({
        model: 'music-2.6',
        output_format: 'hex',
        is_instrumental: true,
        audio_setting: {
          format: 'mp3'
        }
      });
      const artifact = run.result.artifacts[0]!;
      const bytes = await readFile(join(run.projectRoot, artifact.projectRelativePath));
      expect(Buffer.from(bytes).toString('hex')).toBe('010203');
      expect(artifact.mimeType).toBe('audio/mpeg');
    } finally {
      await run.cleanup();
    }
  });

  it('wraps Gemini L16 PCM audio in WAV output', async () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]).toString('base64');
    const run = await runAudioModelForTest({
      model: 'gemini-tts',
      requestedKind: 'tts',
      args: {
        text: 'Read this line.',
        output_path: 'generated/gemini.wav'
      },
      responses: [{
        body: googleInteractionAudioResponse(pcm, 'audio/L16;codec=pcm;rate=24000')
      }]
    });

    try {
      expect(run.result.status).toBe('ok');
      if (run.result.status !== 'ok') {
        throw new Error(run.result.content);
      }

      const artifact = run.result.artifacts[0]!;
      const bytes = await readFile(join(run.projectRoot, artifact.projectRelativePath));

      expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect(artifact.mimeType).toBe('audio/wav');
    } finally {
      await run.cleanup();
    }
  });

  it('writes Google Lyria interaction output audio bytes exactly', async () => {
    const run = await runAudioModelForTest({
      model: 'google-lyria-3-pro-preview',
      requestedKind: 'music',
      args: {
        prompt: 'Bright synth pop loop.',
        output_path: 'generated/lyria.mp3'
      },
      responses: [{
        body: googleInteractionAudioResponse(tinyMp3.toString('base64'), 'audio/mpeg')
      }]
    });

    try {
      expect(run.result.status).toBe('ok');
      if (run.result.status !== 'ok') {
        throw new Error(run.result.content);
      }
      expect(run.requests[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
      expect(JSON.parse(String(run.requests[0]!.init?.body))).toMatchObject({
        model: 'lyria-3-pro-preview',
        input: 'Bright synth pop loop.'
      });
      const artifact = run.result.artifacts[0]!;
      await expect(readFile(join(run.projectRoot, artifact.projectRelativePath))).resolves.toEqual(tinyMp3);
    } finally {
      await run.cleanup();
    }
  });

  it('downloads DashScope output audio URL through the remote fetch policy', async () => {
    const run = await runAudioModelForTest({
      model: 'dashscope-qwen3-tts-flash',
      requestedKind: 'tts',
      args: {
        text: 'Read this line.',
        output_path: 'generated/dashscope.wav'
      },
      responses: [{
        body: {
          output: {
            audio: {
              url: 'https://media.example/dashscope.wav'
            }
          },
          request_id: 'dashscope-request'
        }
      }],
      remoteBytes: tinyMp3,
      remoteMimeType: 'audio/wav'
    });

    try {
      expect(run.result.status).toBe('ok');
      if (run.result.status !== 'ok') {
        throw new Error(run.result.content);
      }
      const artifact = run.result.artifacts[0]!;
      await expect(readFile(join(run.projectRoot, artifact.projectRelativePath))).resolves.toEqual(tinyMp3);
      expect(artifact.mimeType).toBe('audio/wav');
      expect(run.remoteRequests[0]?.signal).toBeDefined();
    } finally {
      await run.cleanup();
    }
  });

  it('decodes Volcengine Seed TTS base64 audio frames', async () => {
    const run = await runAudioModelForTest({
      model: 'doubao-seed-tts-2-0',
      requestedKind: 'tts',
      args: {
        text: 'Read this line.',
        voice: 'BV700_V2_streaming',
        output_path: 'generated/doubao.mp3'
      },
      responses: [{
        headers: { 'content-type': 'application/json' },
        bytes: Buffer.from('{"data":"AQID"}{"code":20000000,"message":"ok"}')
      }]
    });

    try {
      expect(run.result.status).toBe('ok');
      if (run.result.status !== 'ok') {
        throw new Error(run.result.content);
      }
      expect(new Headers(run.requests[0]!.init?.headers).get('x-api-resource-id')).toBe('seed-tts-2.0');
      const artifact = run.result.artifacts[0]!;
      const bytes = await readFile(join(run.projectRoot, artifact.projectRelativePath));
      expect(Buffer.from(bytes).toString('hex')).toBe('010203');
    } finally {
      await run.cleanup();
    }
  });

  it('runs ElevenLabs music and sound effects as binary audio responses', async () => {
    const music = await runAudioModelForTest({
      model: 'elevenlabs-music',
      requestedKind: 'music',
      args: {
        prompt: 'Warm ambient electronic music.',
        duration_seconds: 3,
        output_path: 'generated/eleven-music.mp3'
      },
      responses: [{
        headers: { 'content-type': 'audio/mpeg' },
        bytes: tinyMp3
      }]
    });
    const sfx = await runAudioModelForTest({
      model: 'elevenlabs-sound-effects',
      requestedKind: 'sound-effect',
      args: {
        prompt: 'Clean notification chime.',
        duration_seconds: 1,
        output_path: 'generated/eleven-sfx.mp3'
      },
      responses: [{
        headers: { 'content-type': 'audio/mpeg' },
        bytes: tinyMp3
      }]
    });

    try {
      expect(music.result.status).toBe('ok');
      expect(sfx.result.status).toBe('ok');
      expect(JSON.parse(String(music.requests[0]!.init?.body))).toMatchObject({
        model_id: 'music_v2',
        music_length_ms: 3000
      });
      expect(JSON.parse(String(sfx.requests[0]!.init?.body))).toMatchObject({
        model_id: 'eleven_text_to_sound_v2',
        duration_seconds: 1
      });
    } finally {
      await music.cleanup();
      await sfx.cleanup();
    }
  });

  it('requires ElevenLabs TTS voice_id before making requests', async () => {
    const run = await runAudioModelForTest({
      model: 'elevenlabs-v3-tts',
      requestedKind: 'tts',
      args: { text: 'Read this line.' },
      responses: []
    });

    try {
      expect(run.requests).toEqual([]);
      expect(run.result).toMatchObject({
        status: 'error',
        error: 'audio_argument_invalid'
      });
      expect(run.result.content).toContain('ElevenLabs TTS audio arguments require string field "voice_id".');
    } finally {
      await run.cleanup();
    }
  });

  it('rejects fields that are not declared by the selected audio model schema', async () => {
    const run = await runAudioModelForTest({
      model: 'elevenlabs-music',
      requestedKind: 'music',
      args: {
        prompt: 'Warm ambient electronic music.',
        lyrics: 'Words the ElevenLabs compose endpoint does not accept.'
      },
      responses: []
    });

    try {
      expect(run.requests).toEqual([]);
      expect(run.result).toMatchObject({
        status: 'error',
        error: 'audio_argument_invalid'
      });
      expect(run.result.content).toContain('Unsupported audio argument for elevenlabs-music: lyrics.');
    } finally {
      await run.cleanup();
    }
  });

  it('polls fal task success and downloads the final artifact URL', async () => {
    const run = await runAudioModelForTest({
      model: 'fal-stable-audio-text-to-audio',
      requestedKind: 'music',
      args: {
        prompt: 'Tense synth pulse.',
        duration_seconds: 20,
        output_path: 'generated/fal.wav'
      },
      responses: [
        {
          body: {
            request_id: 'audio-task-1',
            status_url: 'https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio/requests/audio-task-1/status',
            response_url: 'https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio/requests/audio-task-1/response'
          }
        },
        {
          body: {
            status: 'COMPLETED',
            request_id: 'audio-task-1',
            response_url: 'https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio/requests/audio-task-1/response'
          }
        },
        { body: { audio: 'https://media.example/fal.wav', seed: 7 } }
      ],
      remoteBytes: tinyMp3,
      remoteMimeType: 'audio/wav'
    });

    try {
      expect(run.result.status).toBe('ok');
      if (run.result.status !== 'ok') {
        throw new Error(run.result.content);
      }
      expect(run.requests.map((request) => request.url)).toEqual([
        'https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio',
        'https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio/requests/audio-task-1/status',
        'https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio/requests/audio-task-1/response'
      ]);
      const artifact = run.result.artifacts[0]!;
      await expect(readFile(join(run.projectRoot, artifact.projectRelativePath))).resolves.toEqual(tinyMp3);
    } finally {
      await run.cleanup();
    }
  });

  it('polls fal sound effect task success from the documented file object', async () => {
    const run = await runAudioModelForTest({
      model: 'fal-stable-audio-sfx',
      requestedKind: 'sound-effect',
      args: {
        prompt: 'Soft hydraulic door.',
        duration_seconds: 4,
        format: 'mp3',
        output_path: 'generated/fal-sfx.mp3'
      },
      responses: [
        {
          body: {
            request_id: 'audio-task-2',
            status_url: 'https://queue.fal.run/fal-ai/stable-audio-3/medium/base/text-to-audio/requests/audio-task-2/status',
            response_url: 'https://queue.fal.run/fal-ai/stable-audio-3/medium/base/text-to-audio/requests/audio-task-2/response'
          }
        },
        {
          body: {
            status: 'COMPLETED',
            request_id: 'audio-task-2',
            response_url: 'https://queue.fal.run/fal-ai/stable-audio-3/medium/base/text-to-audio/requests/audio-task-2/response'
          }
        },
        {
          body: {
            audio: {
              url: 'https://media.example/fal-sfx.mp3',
              content_type: 'audio/mpeg',
              file_name: 'fal-sfx.mp3'
            },
            prompt: 'Soft hydraulic door.'
          }
        }
      ],
      remoteBytes: tinyMp3,
      remoteMimeType: 'audio/mpeg'
    });

    try {
      expect(run.result.status).toBe('ok');
      if (run.result.status !== 'ok') {
        throw new Error(run.result.content);
      }
      expect(JSON.parse(String(run.requests[0]!.init?.body))).toMatchObject({
        prompt: 'Soft hydraulic door.',
        duration: 4,
        output_format: 'mp3'
      });
    } finally {
      await run.cleanup();
    }
  });

  it('rejects unsupported or undeclared model-specific audio formats before making requests', async () => {
    const cases: Array<{
      model: string;
      requestedKind: 'tts' | 'music';
      args: Record<string, unknown>;
      expectedMessage: string;
    }> = [
      {
        model: 'dashscope-qwen3-tts-flash',
        requestedKind: 'tts',
        args: { text: 'Read this line.', format: 'mp3' },
        expectedMessage: 'Unsupported audio argument for dashscope-qwen3-tts-flash: format.'
      },
      {
        model: 'google-lyria-3-clip-preview',
        requestedKind: 'music',
        args: { prompt: 'Bright synth pop loop.', format: 'wav' },
        expectedMessage: 'Unsupported audio argument for google-lyria-3-clip-preview: format.'
      },
      {
        model: 'google-lyria-3-pro-preview',
        requestedKind: 'music',
        args: { prompt: 'Bright synth pop loop.', format: 'flac' },
        expectedMessage: 'format must be one of: mp3, wav'
      }
    ];

    for (const item of cases) {
      const run = await runAudioModelForTest({
        model: item.model,
        requestedKind: item.requestedKind,
        args: item.args,
        responses: []
      });
      try {
        expect(run.requests, item.model).toEqual([]);
        expect(run.result).toMatchObject({
          status: 'error',
          error: 'audio_argument_invalid'
        });
        expect(run.result.content).toContain(item.expectedMessage);
      } finally {
        await run.cleanup();
      }
    }
  });

  it('rejects private audio artifact URLs through the audio executor', async () => {
    const run = await runAudioModelForTest({
      model: 'dashscope-qwen3-tts-flash',
      requestedKind: 'tts',
      args: {
        text: 'Read this line.',
        output_path: 'generated/private.wav'
      },
      responses: [{
        body: {
          output: {
            audio: {
              url: 'http://127.0.0.1:54321/private.wav'
            }
          },
          request_id: 'dashscope-private-url'
        }
      }]
    });

    try {
      expect(run.result).toMatchObject({
        status: 'error',
        error: 'audio_artifact_download_failed'
      });
      expect(run.result.content).toContain('Audio artifact URL must not target local or private network hosts');
      expect(run.remoteRequests).toEqual([]);
    } finally {
      await run.cleanup();
    }
  });

  it('requires fal sound effect result content type instead of deriving MIME from request format', async () => {
    const run = await runAudioModelForTest({
      model: 'fal-stable-audio-sfx',
      requestedKind: 'sound-effect',
      args: {
        prompt: 'Soft hydraulic door.',
        format: 'mp3'
      },
      responses: [
        {
          body: {
            request_id: 'audio-task-3',
            status_url: 'https://queue.fal.run/fal-ai/stable-audio-3/medium/base/text-to-audio/requests/audio-task-3/status',
            response_url: 'https://queue.fal.run/fal-ai/stable-audio-3/medium/base/text-to-audio/requests/audio-task-3/response'
          }
        },
        {
          body: {
            status: 'COMPLETED',
            request_id: 'audio-task-3',
            response_url: 'https://queue.fal.run/fal-ai/stable-audio-3/medium/base/text-to-audio/requests/audio-task-3/response'
          }
        },
        {
          body: {
            audio: {
              url: 'https://media.example/fal-sfx.mp3'
            }
          }
        }
      ]
    });

    try {
      expect(run.result).toMatchObject({
        status: 'error',
        error: 'audio_request_failed'
      });
      expect(run.result.content).toContain('content_type');
    } finally {
      await run.cleanup();
    }
  });

  it('rejects Gemini interaction audio MIME types outside the official audio contract', async () => {
    const run = await runAudioModelForTest({
      model: 'gemini-tts',
      requestedKind: 'tts',
      args: {
        text: 'Read this line.',
        output_path: 'generated/gemini-unknown.bin'
      },
      responses: [{
        body: googleInteractionAudioResponse(tinyMp3.toString('base64'), 'application/json')
      }]
    });

    try {
      expect(run.result).toMatchObject({
        status: 'error',
        error: 'audio_request_failed'
      });
      expect(run.result.content).toContain('Unsupported audio MIME type: application/json');
    } finally {
      await run.cleanup();
    }
  });

  it('rejects URL audio artifacts with unsupported MIME types instead of writing fallback files', async () => {
    const run = await runAudioModelForTest({
      model: 'fal-stable-audio-sfx',
      requestedKind: 'sound-effect',
      args: {
        prompt: 'Soft hydraulic door.',
        format: 'mp3',
        output_path: 'generated/fal-sfx.bin'
      },
      responses: [
        {
          body: {
            request_id: 'audio-task-unsupported-mime',
            status_url: 'https://queue.fal.run/fal-ai/stable-audio-3/medium/base/text-to-audio/requests/audio-task-unsupported-mime/status',
            response_url: 'https://queue.fal.run/fal-ai/stable-audio-3/medium/base/text-to-audio/requests/audio-task-unsupported-mime/response'
          }
        },
        {
          body: {
            status: 'COMPLETED',
            request_id: 'audio-task-unsupported-mime',
            response_url: 'https://queue.fal.run/fal-ai/stable-audio-3/medium/base/text-to-audio/requests/audio-task-unsupported-mime/response'
          }
        },
        {
          body: {
            audio: {
              url: 'https://media.example/fal-sfx.json',
              content_type: 'application/json',
              file_name: 'fal-sfx.json'
            }
          }
        }
      ],
      remoteBytes: Buffer.from('{"error":"not audio"}'),
      remoteMimeType: 'application/json'
    });

    try {
      expect(run.result).toMatchObject({
        status: 'error',
        error: 'audio_request_failed'
      });
      expect(run.result.content).toContain('Unsupported audio MIME type: application/json');
      await expect(readFile(join(run.projectRoot, 'generated/fal-sfx.bin'))).rejects.toThrow();
    } finally {
      await run.cleanup();
    }
  });

  it('maps documented async task failure to audio_task_failed', async () => {
    const run = await runAudioModelForTest({
      model: 'fal-stable-audio-text-to-audio',
      requestedKind: 'music',
      args: { prompt: 'Tense synth pulse.' },
      responses: [
        {
          body: {
            request_id: 'audio-task-1',
            status_url: 'https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio/requests/audio-task-1/status',
            response_url: 'https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio/requests/audio-task-1/response'
          }
        },
        {
          body: {
            status: 'COMPLETED',
            request_id: 'audio-task-1',
            response_url: 'https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio/requests/audio-task-1/response',
            error: 'synthesis failed',
            error_type: 'model_error'
          }
        }
      ]
    });

    try {
      expect(run.result).toMatchObject({
        status: 'error',
        error: 'audio_task_failed'
      });
    } finally {
      await run.cleanup();
    }
  });

  it('maps exhausted fal task polling to audio_task_timeout', async () => {
    const run = await runAudioModelForTest({
      model: 'fal-stable-audio-text-to-audio',
      requestedKind: 'music',
      args: { prompt: 'Tense synth pulse.' },
      responses: [
        {
          body: {
            request_id: 'audio-task-timeout',
            status_url: 'https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio/requests/audio-task-timeout/status',
            response_url: 'https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio/requests/audio-task-timeout/response'
          }
        },
        {
          body: {
            status: 'IN_PROGRESS',
            request_id: 'audio-task-timeout',
            response_url: 'https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio/requests/audio-task-timeout/response'
          }
        },
        {
          body: {
            status: 'IN_PROGRESS',
            request_id: 'audio-task-timeout',
            response_url: 'https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio/requests/audio-task-timeout/response'
          }
        }
      ],
      taskPolling: { intervalMs: 0, maxAttempts: 2 }
    });

    try {
      expect(run.result).toMatchObject({
        status: 'error',
        error: 'audio_task_timeout'
      });
    } finally {
      await run.cleanup();
    }
  });

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

  it('rejects mismatched CLI audio kind without calling a model adapter', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-kind-mismatch-'));
    try {
      const result = await executeAudioModelRequest({
        projectRoot,
        invocationId: 'turn-audio',
        requestedKind: 'music',
        input: {
          model: 'openai-gpt-4o-mini-tts',
          arguments: { text: 'Read this line.' }
        },
        settings: { audioModels: [] },
        secrets: { audioModelApiKeys: { 'openai-gpt-4o-mini-tts': [{ id: 'aud-a', key: 'sk-audio', label: null, enabled: true }] } },
        fetch: async () => {
          throw new Error('adapter should not run');
        }
      });

      expect(result).toMatchObject({
        status: 'error',
        error: 'audio_model_kind_mismatch'
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects unavailable audio models before adapter execution', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-unknown-model-'));
    try {
      const result = await executeAudioModelRequest({
        projectRoot,
        invocationId: 'turn-audio',
        requestedKind: 'tts',
        input: {
          model: 'missing-audio-model',
          arguments: { text: 'Read this line.' }
        },
        settings: { audioModels: [] },
        secrets: { audioModelApiKeys: { 'missing-audio-model': [{ id: 'aud-a', key: 'sk-audio', label: null, enabled: true }] } },
        fetch: async () => {
          throw new Error('adapter should not run');
        }
      });

      expect(result).toMatchObject({
        status: 'error',
        error: 'audio_model_unavailable'
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('validates TTS, music, and sound-effect arguments before adapter execution', async () => {
    const cases: Array<{
      model: string;
      requestedKind: 'tts' | 'music' | 'sound-effect';
      args: Record<string, unknown>;
      expectedMessage: string;
    }> = [
      {
        model: 'openai-gpt-4o-mini-tts',
        requestedKind: 'tts',
        args: { voice: 'alloy' },
        expectedMessage: 'TTS audio arguments require string field "text".'
      },
      {
        model: 'elevenlabs-music',
        requestedKind: 'music',
        args: { prompt: 'Warm loop.', duration_seconds: '30' },
        expectedMessage: 'Music audio arguments duration_seconds must be a number.'
      },
      {
        model: 'elevenlabs-sound-effects',
        requestedKind: 'sound-effect',
        args: { prompt: 'Chime.', loop: 'yes' },
        expectedMessage: 'Sound effect audio arguments loop must be a boolean.'
      }
    ];

    for (const item of cases) {
      const run = await runAudioModelForTest({
        model: item.model,
        requestedKind: item.requestedKind,
        args: item.args,
        responses: []
      });
      try {
        expect(run.requests, item.model).toEqual([]);
        expect(run.result).toMatchObject({
          status: 'error',
          error: 'audio_argument_invalid'
        });
        expect(run.result.content).toBe(item.expectedMessage);
      } finally {
        await run.cleanup();
      }
    }
  });

  it('requires configured audio model API keys', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-missing-key-'));
    try {
      const result = await executeAudioModelRequest({
        projectRoot,
        invocationId: 'turn-audio',
        requestedKind: 'sound-effect',
        input: {
          model: 'elevenlabs-sound-effects',
          arguments: { prompt: 'Short glass chime.' }
        },
        settings: { audioModels: [] },
        secrets: { audioModelApiKeys: {} },
        fetch: async () => {
          throw new Error('adapter should not run');
        }
      });

      expect(result).toMatchObject({
        status: 'error',
        error: 'audio_model_not_configured'
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function runAudioModelForTest(input: {
  model: string;
  requestedKind: 'tts' | 'music' | 'sound-effect';
  args: Record<string, unknown>;
  responses: Array<{ status?: number; headers?: Record<string, string>; body?: unknown; bytes?: Uint8Array }>;
  taskPolling?: { intervalMs?: number; maxAttempts?: number };
  remoteBytes?: Uint8Array;
  remoteMimeType?: string;
  apiKey?: string;
}) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const remoteRequests: Array<{ signal?: AbortSignal }> = [];
  const responses = [...input.responses];
  const fetch: AudioModelFetch = async (url, init) => {
    requests.push({ url, init });
    const next = responses.shift();
    if (!next) {
      throw new Error(`Unexpected audio test fetch: ${url}`);
    }
    const headers = new Headers(next.headers);
    if (next.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return new Response(next.body === undefined ? next.bytes : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers
    });
  };

  const result = await executeAudioModelRequest({
    projectRoot,
    invocationId: 'turn-audio',
    requestedKind: input.requestedKind,
    input: { model: input.model, arguments: input.args },
    settings: {
      audioModels: [{
        debruteModelId: input.model,
        baseUrlOverride: null,
        requestModelIdOverride: null
      }]
    },
    secrets: { audioModelApiKeys: { [input.model]: [{ id: 'aud-a', key: input.apiKey ?? 'sk-audio', label: null, enabled: true }] } },
    fetch,
    ...(input.taskPolling ? { taskPolling: input.taskPolling } : {}),
    remoteUrlLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    remoteHttpTransport: async (request) => {
      remoteRequests.push({ signal: request.signal });
      return new Response(input.remoteBytes ?? tinyMp3, {
        status: 200,
        headers: { 'content-type': input.remoteMimeType ?? 'audio/mpeg' }
      });
    }
  });

  return {
    projectRoot,
    requests,
    remoteRequests,
    result,
    cleanup: () => rm(projectRoot, { recursive: true, force: true })
  };
}

function googleInteractionAudioResponse(data: string, mimeType: string): Record<string, unknown> {
  return {
    steps: [{
      type: 'model_output',
      content: [{
        type: 'audio',
        data,
        mime_type: mimeType
      }]
    }]
  };
}
