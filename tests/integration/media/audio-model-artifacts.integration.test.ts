import { tinyMp3Bytes } from '../../fixtures/mediaModelInputs';
import { executeAudioModelTestRequest } from '../../helpers/audioModelTestRequests';

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

describe('audio model artifacts', () => {
  it('rejects private audio artifact URLs through the audio executor', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });

  it('requires fal sound effect result content type instead of deriving MIME from request format', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });

  it('rejects Gemini interaction audio MIME types outside the official audio contract', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
      model: 'gemini-tts',
      requestedKind: 'tts',
      args: {
        text: 'Read this line.',
        output_path: 'generated/gemini-unknown.bin'
      },
      responses: [{
        body: googleInteractionAudioResponse(tinyMp3Bytes().toString('base64'), 'application/json')
      }]
    });

    try {
      expect(run.result).toMatchObject({
        status: 'error',
        error: 'audio_request_failed'
      });
      expect(run.result.content).toContain('Unsupported audio MIME type: application/json');
    } finally {
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });

  it('rejects URL audio artifacts with unsupported MIME types instead of writing fallback files', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      await expect(readFile(join(runProjectRoot, 'generated/fal-sfx.bin'))).rejects.toThrow();
    } finally {
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });
});
