
import { executeAudioModelTestRequest } from '../../helpers/audioModelTestRequests';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('audio model lifecycle', () => {
  it('redacts audio API keys from upstream JSON failure messages while preserving response structure', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });

  it('maps documented async task failure to audio_task_failed', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });

  it('maps exhausted fal task polling to audio_task_timeout', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });
});
