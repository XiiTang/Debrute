
import { executeAudioModelTestRequest } from '../../helpers/audioModelTestRequests';
import { executeAudioModelRequest } from '@debrute/capability-runtime';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('audio model inputs', () => {
  it('requires ElevenLabs TTS voice_id before making requests', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });

  it('rejects fields that are not declared by the selected audio model schema', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      await rm(runProjectRoot, { recursive: true, force: true });
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
      const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
      const run = await executeAudioModelTestRequest({
        projectRoot: runProjectRoot,
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
        await rm(runProjectRoot, { recursive: true, force: true });
      }
    }
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
        secrets: { audioModelApiKeys: { 'openai-gpt-4o-mini-tts': 'sk-audio' } },
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
        secrets: { audioModelApiKeys: { 'missing-audio-model': 'sk-audio' } },
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
        model: 'openai-gpt-4o-mini-tts',
        requestedKind: 'tts',
        args: { text: '   ' },
        expectedMessage: 'TTS audio arguments require string field "text".'
      },
      {
        model: 'elevenlabs-music',
        requestedKind: 'music',
        args: {},
        expectedMessage: 'Music audio arguments require string field "prompt".'
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
        args: { prompt: '   ' },
        expectedMessage: 'Sound effect audio arguments require string field "prompt".'
      },
      {
        model: 'elevenlabs-sound-effects',
        requestedKind: 'sound-effect',
        args: { prompt: 'Chime.', loop: 'yes' },
        expectedMessage: 'Sound effect audio arguments loop must be a boolean.'
      }
    ];

    for (const item of cases) {
      const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
      const run = await executeAudioModelTestRequest({
        projectRoot: runProjectRoot,
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
        await rm(runProjectRoot, { recursive: true, force: true });
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
