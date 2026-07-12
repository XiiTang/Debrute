import { tinyMp4Bytes, tinyPngBase64, tinyPngBytes, tinyWavBytes } from '../../fixtures/mediaModelInputs';
import { executeVideoModelRequestAndCaptureBody, executeVideoModelTestRequest } from '../../helpers/videoModelTestRequests';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('video model inputs', () => {
  it('infers supported project image formats for Seedance references through the image registry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-image-registry-'));
    try {
      await writeFile(join(projectRoot, 'first.avif'), tinyPngBytes());
      await writeFile(join(projectRoot, 'last.jfif'), tinyPngBytes());

      const captured = await executeVideoModelRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-registry-images',
        arguments: {
          prompt: 'animate the product',
          intent: 'generate',
          references: [{ source: 'first.avif' }, { source: 'last.jfif' }]
        }
      });

      expect(captured.result.status).toBe('ok');
      expect(JSON.stringify(captured.body?.content)).toContain(`data:image/avif;base64,${tinyPngBase64}`);
      expect(JSON.stringify(captured.body?.content)).toContain(`data:image/jpeg;base64,${tinyPngBase64}`);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('infers all-purpose reference routing from reference media types', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-reference-routing-'));
    try {
      await writeFile(join(projectRoot, 'reference.png'), tinyPngBytes());
      await writeFile(join(projectRoot, 'sound.wav'), tinyWavBytes());

      const captured = await executeVideoModelRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-reference',
        arguments: {
          prompt: 'combine the visual reference, motion reference, and music',
          intent: 'reference',
          references: [
            { source: 'reference.png' },
            { source: 'https://cdn.example/motion.mp4' },
            { source: 'sound.wav' }
          ],
          generate_audio: true
        }
      });

      expect(captured.result.status).toBe('ok');
      expect(captured.body?.content).toEqual([
        { type: 'text', text: 'combine the visual reference, motion reference, and music' },
        expect.objectContaining({ type: 'image_url', role: 'reference_image' }),
        expect.objectContaining({ type: 'video_url', role: 'reference_video', video_url: { url: 'https://cdn.example/motion.mp4' } }),
        expect.objectContaining({ type: 'audio_url', role: 'reference_audio' })
      ]);
      expect(JSON.stringify(captured.body?.content)).toContain('data:audio/wav;base64,');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('routes project-local video references through the upload service boundary', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-upload-boundary-'));
    try {
      await writeFile(join(projectRoot, 'clip.mp4'), tinyMp4Bytes());
      const uploads: unknown[] = [];

      const captured = await executeVideoModelRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-local-upload',
        arguments: {
          prompt: 'use the local motion reference',
          intent: 'reference',
          references: [{ source: 'clip.mp4' }]
        },
        uploadVideoReference: async (input) => {
          uploads.push(input);
          return { url: 'https://uploads.example/clip.mp4', expiresAt: '2026-06-09T12:00:00.000Z' };
        }
      });

      expect(captured.result.status).toBe('ok');
      expect(uploads).toEqual([{
        projectPath: projectRoot,
        projectRelativePath: 'clip.mp4',
        contentType: 'video/mp4',
        byteLength: tinyMp4Bytes().byteLength
      }]);
      expect(captured.body?.content).toEqual([
        { type: 'text', text: 'use the local motion reference' },
        { type: 'video_url', video_url: { url: 'https://uploads.example/clip.mp4' }, role: 'reference_video' }
      ]);

      const missingUpload = await executeVideoModelTestRequest({
        projectRoot,
        invocationId: 'turn-video-local-upload-missing',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'use the local motion reference',
            intent: 'reference',
            references: [{ source: 'clip.mp4' }]
          }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => {
          throw new Error('upstream request should not run without upload service');
        }
      });

      expect(missingUpload.status).toBe('error');
      if (missingUpload.status !== 'error') {
        throw new Error(missingUpload.content);
      }
      expect(missingUpload.error).toBe('video_reference_upload_unavailable');
      expect(missingUpload.content).toContain('Seedance-reachable URL or asset reference');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('routes large project-local video references through upload without local size validation', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-large-upload-boundary-'));
    try {
      const largeVideo = Buffer.alloc(20 * 1024 * 1024 + 1, 1);
      await writeFile(join(projectRoot, 'large.mp4'), largeVideo);
      const uploads: unknown[] = [];

      const captured = await executeVideoModelRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-large-local-upload',
        arguments: {
          prompt: 'use the large local motion reference',
          intent: 'reference',
          references: [{ source: 'large.mp4' }]
        },
        uploadVideoReference: async (input) => {
          uploads.push(input);
          return { url: 'https://uploads.example/large.mp4' };
        }
      });

      expect(captured.result.status).toBe('ok');
      expect(uploads).toEqual([{
        projectPath: projectRoot,
        projectRelativePath: 'large.mp4',
        contentType: 'video/mp4',
        byteLength: largeVideo.byteLength
      }]);
      expect(captured.body?.content).toContainEqual({
        type: 'video_url',
        video_url: { url: 'https://uploads.example/large.mp4' },
        role: 'reference_video'
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('routes edit masks through image data URLs and rejects unknown reference fields', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-edit-mask-'));
    try {
      const captured = await executeVideoModelRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-edit-mask',
        arguments: {
          prompt: 'replace the background',
          intent: 'edit',
          references: [{
            source: `data:image/png;base64,${tinyPngBase64}`,
            media_type: 'mask'
          }]
        }
      });

      expect(captured.result.status).toBe('ok');
      expect(captured.body?.content).toEqual([
        { type: 'text', text: 'replace the background' },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${tinyPngBase64}` },
          role: 'mask'
        }
      ]);

      const result = await executeVideoModelTestRequest({
        projectRoot,
        invocationId: 'turn-video-reference-extra-field',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'reject extra reference field',
            references: [{ source: 'https://cdn.example/frame.png', weight: 0.5 }]
          }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported reference fields');
        }
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
      expect(result.error).toBe('video_argument_invalid');
      expect(result.content).toContain('Unsupported video reference argument: references[0].weight');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('validates video image data URLs through the image registry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-data-image-registry-'));
    try {
      const accepted = await executeVideoModelRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-data-avif',
        arguments: {
          prompt: 'animate the product',
          intent: 'generate',
          references: [{ source: `data:image/avif;base64,${tinyPngBase64}` }]
        }
      });

      expect(accepted.result.status).toBe('ok');
      expect(JSON.stringify(accepted.body?.content)).toContain(`data:image/avif;base64,${tinyPngBase64}`);

      const rejected = await executeVideoModelTestRequest({
        projectRoot,
        invocationId: 'turn-video-data-gif',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'reject gif',
            intent: 'generate',
            references: [{ source: `data:image/gif;base64,${tinyPngBase64}` }]
          }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported image data URLs');
        }
      });

      expect(rejected.status).toBe('error');
      if (rejected.status !== 'error') {
        throw new Error(rejected.content);
      }
      expect(rejected.error).toBe('video_reference_type_unsupported');
      expect(rejected.content).toContain('Unsupported Debrute project image data URL MIME type: image/gif');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported video image URL paths through the image registry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-image-url-registry-'));
    try {
      const result = await executeVideoModelTestRequest({
        projectRoot,
        invocationId: 'turn-video-image-url-gif',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'reject gif reference',
            intent: 'generate',
            references: [{ source: 'https://cdn.example/source.gif', media_type: 'image' }]
          }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported image URL paths');
        }
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
      expect(result.error).toBe('video_reference_type_unsupported');
      expect(result.content).toBe('Unsupported Debrute project image URL reference: https://cdn.example/source.gif');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported public video arguments before upstream execution', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-unsupported-argument-'));
    try {
      const result = await executeVideoModelTestRequest({
        projectRoot,
        invocationId: 'turn-video-unsupported-argument',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: { prompt: 'request brief', content: [{ type: 'text', text: 'not public schema' }] }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported arguments');
        }
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
      expect(result.error).toBe('video_argument_invalid');
      expect(result.content).toContain('Unsupported video request argument: content');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid Seedance argument values before upstream execution', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-invalid-argument-values-'));
    try {
      for (const args of [
        { prompt: 'request brief', resolution: '1080p' },
        { prompt: 'request brief', ratio: '2:1' },
        { prompt: 'request brief', return_last_frame: 'yes' },
        { prompt: 'request brief', duration: 0 },
        { prompt: 'request brief', duration: 99 }
      ]) {
        const result = await executeVideoModelTestRequest({
          projectRoot,
          invocationId: 'turn-video-invalid-argument-values',
          input: {
            model: 'doubao-seedance-2-0-fast-260128',
            arguments: args
          },
          settings: {
            videoModels: [{ debruteModelId: 'doubao-seedance-2-0-fast-260128', baseUrlOverride: null, requestModelIdOverride: null }]
          },
          secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-fast-260128': 'sk-video' } },
          fetch: async () => {
            throw new Error('upstream request should not run for invalid argument values');
          }
        });

        expect(result.status).toBe('error');
        if (result.status !== 'error') {
          throw new Error(result.content);
        }
        expect(result.error).toBe('video_argument_invalid');
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('validates video intent reference combinations before local video upload', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-reference-preflight-'));
    let uploadCalls = 0;
    try {
      await writeFile(join(projectRoot, 'clip.mp4'), tinyMp4Bytes());

      const result = await executeVideoModelTestRequest({
        projectRoot,
        invocationId: 'turn-video-reference-preflight',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'request brief',
            intent: 'generate',
            references: [{ source: 'clip.mp4' }]
          }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        uploadVideoReference: async () => {
          uploadCalls += 1;
          return { url: 'https://uploads.example/clip.mp4' };
        },
        fetch: async () => {
          throw new Error('upstream request should not run for invalid reference combinations');
        }
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
      expect(result.error).toBe('video_reference_type_unsupported');
      expect(uploadCalls).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
