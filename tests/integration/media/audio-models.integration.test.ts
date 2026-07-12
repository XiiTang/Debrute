import { tinyMp3Bytes } from '../../fixtures/mediaModelInputs';
import { executeAudioModelTestRequest } from '../../helpers/audioModelTestRequests';
import { executeAudioModelRequest } from '@debrute/capability-runtime';
import type { AudioModelFetch } from '@debrute/capability-runtime';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

describe('audio model providers', () => {
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
      return new Response(tinyMp3Bytes(), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
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
        secrets: { audioModelApiKeys: { 'openai-gpt-4o-mini-tts': 'sk-audio' } },
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
      await expect(readFile(join(projectRoot, 'generated/read-this-line.mp3'))).resolves.toEqual(tinyMp3Bytes());
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

  it('wraps OpenAI PCM bytes as a WAV artifact', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      const bytes = await readFile(join(runProjectRoot, artifact.projectRelativePath));
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect(artifact.mimeType).toBe('audio/wav');
    } finally {
      await rm(runProjectRoot, { recursive: true, force: true });
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
        responses: [{ headers: { 'content-type': 'audio/mpeg' }, bytes: tinyMp3Bytes() }],
        assertRequest: (requests) => {
          expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({ model: 'tts-1' });
        }
      },
      {
        model: 'openai-tts-1-hd',
        requestedKind: 'tts',
        args: { text: 'Read this line.', output_path: 'generated/openai-tts-1-hd.mp3' },
        responses: [{ headers: { 'content-type': 'audio/mpeg' }, bytes: tinyMp3Bytes() }],
        assertRequest: (requests) => {
          expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({ model: 'tts-1-hd' });
        }
      },
      {
        model: 'elevenlabs-v3-tts',
        requestedKind: 'tts',
        args: { text: 'Read this line.', voice_id: 'JBFqnCBsd6RMkjVDRZzb', output_path: 'generated/eleven-v3.mp3' },
        responses: [{ headers: { 'content-type': 'audio/mpeg' }, bytes: tinyMp3Bytes() }],
        assertRequest: (requests) => {
          expect(requests[0]!.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128');
          expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({ model_id: 'eleven_v3' });
        }
      },
      {
        model: 'elevenlabs-multilingual-v2',
        requestedKind: 'tts',
        args: { text: 'Read this line.', voice_id: 'JBFqnCBsd6RMkjVDRZzb', output_path: 'generated/eleven-multilingual.mp3' },
        responses: [{ headers: { 'content-type': 'audio/mpeg' }, bytes: tinyMp3Bytes() }],
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
          body: googleInteractionAudioResponse(tinyMp3Bytes().toString('base64'), 'audio/mpeg')
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
      const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
      const { assertRequest, ...request } = item;
      const run = await executeAudioModelTestRequest({
        projectRoot: runProjectRoot,
        ...request
      });
      try {
        expect(run.result.status, item.model).toBe('ok');
        if (run.result.status !== 'ok') {
          throw new Error(run.result.content);
        }
        assertRequest(run.requests);
      } finally {
        await rm(runProjectRoot, { recursive: true, force: true });
      }
    }
  });

  it('writes MiniMax TTS hex audio bytes exactly', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      const bytes = await readFile(join(runProjectRoot, artifact.projectRelativePath));

      expect(Buffer.from(bytes).toString('hex')).toBe('010203');
      expect(artifact.mimeType).toBe('audio/mpeg');
    } finally {
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });

  it('writes MiniMax music hex audio bytes exactly', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      const bytes = await readFile(join(runProjectRoot, artifact.projectRelativePath));
      expect(Buffer.from(bytes).toString('hex')).toBe('010203');
      expect(artifact.mimeType).toBe('audio/mpeg');
    } finally {
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });

  it('wraps Gemini L16 PCM audio in WAV output', async () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]).toString('base64');
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      const bytes = await readFile(join(runProjectRoot, artifact.projectRelativePath));

      expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect(artifact.mimeType).toBe('audio/wav');
    } finally {
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });

  it('writes Google Lyria interaction output audio bytes exactly', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
      model: 'google-lyria-3-pro-preview',
      requestedKind: 'music',
      args: {
        prompt: 'Bright synth pop loop.',
        output_path: 'generated/lyria.mp3'
      },
      responses: [{
        body: googleInteractionAudioResponse(tinyMp3Bytes().toString('base64'), 'audio/mpeg')
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
      await expect(readFile(join(runProjectRoot, artifact.projectRelativePath))).resolves.toEqual(tinyMp3Bytes());
    } finally {
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });

  it('decodes Volcengine Seed TTS base64 audio frames', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      const bytes = await readFile(join(runProjectRoot, artifact.projectRelativePath));
      expect(Buffer.from(bytes).toString('hex')).toBe('010203');
    } finally {
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });

  it('runs ElevenLabs music and sound effects as binary audio responses', async () => {
    const musicProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const music = await executeAudioModelTestRequest({
      projectRoot: musicProjectRoot,
      model: 'elevenlabs-music',
      requestedKind: 'music',
      args: {
        prompt: 'Warm ambient electronic music.',
        duration_seconds: 3,
        output_path: 'generated/eleven-music.mp3'
      },
      responses: [{
        headers: { 'content-type': 'audio/mpeg' },
        bytes: tinyMp3Bytes()
      }]
    });
    const sfxProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const sfx = await executeAudioModelTestRequest({
      projectRoot: sfxProjectRoot,
      model: 'elevenlabs-sound-effects',
      requestedKind: 'sound-effect',
      args: {
        prompt: 'Clean notification chime.',
        duration_seconds: 1,
        output_path: 'generated/eleven-sfx.mp3'
      },
      responses: [{
        headers: { 'content-type': 'audio/mpeg' },
        bytes: tinyMp3Bytes()
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
      await rm(musicProjectRoot, { recursive: true, force: true });
      await rm(sfxProjectRoot, { recursive: true, force: true });
    }
  });
});
