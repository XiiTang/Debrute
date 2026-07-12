import { tinyMp3Bytes } from '../../fixtures/mediaModelInputs';
import { executeAudioModelTestRequest } from '../../helpers/audioModelTestRequests';

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('audio model tasks', () => {
  it('downloads DashScope output audio URL through the remote fetch policy', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      remoteBytes: tinyMp3Bytes(),
      remoteMimeType: 'audio/wav'
    });

    try {
      expect(run.result.status).toBe('ok');
      if (run.result.status !== 'ok') {
        throw new Error(run.result.content);
      }
      const artifact = run.result.artifacts[0]!;
      await expect(readFile(join(runProjectRoot, artifact.projectRelativePath))).resolves.toEqual(tinyMp3Bytes());
      expect(artifact.mimeType).toBe('audio/wav');
      expect(run.remoteRequests[0]?.signal).toBeDefined();
    } finally {
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });

  it('polls fal task success and downloads the final artifact URL', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      remoteBytes: tinyMp3Bytes(),
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
      await expect(readFile(join(runProjectRoot, artifact.projectRelativePath))).resolves.toEqual(tinyMp3Bytes());
    } finally {
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });

  it('polls fal sound effect task success from the documented file object', async () => {
    const runProjectRoot = await mkdtemp(join(tmpdir(), 'debrute-audio-model-'));
    const run = await executeAudioModelTestRequest({
      projectRoot: runProjectRoot,
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
      remoteBytes: tinyMp3Bytes(),
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
      await rm(runProjectRoot, { recursive: true, force: true });
    }
  });
});
