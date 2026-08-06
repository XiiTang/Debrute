import { describe, expect, it } from 'vitest';
import { canvasPreviewContinuityKey } from './canvasPreviewContinuity';

describe('canvasPreviewContinuityKey', () => {
  it('scopes presentation continuity by owner and continuity identity', () => {
    const base = canvasPreviewContinuityKey({
      mediaKind: 'video',
      bindingId: 'project-a',
      projectRelativePath: 'media/clip.mp4',
      continuityIdentity: 'sha256:source-a'
    });

    expect(canvasPreviewContinuityKey({
      mediaKind: 'video',
      bindingId: 'project-a',
      projectRelativePath: 'media/clip.mp4',
      continuityIdentity: 'sha256:source-a'
    })).toBe(base);
    expect(canvasPreviewContinuityKey({
      mediaKind: 'video',
      bindingId: 'project-b',
      projectRelativePath: 'media/clip.mp4',
      continuityIdentity: 'sha256:source-a'
    })).not.toBe(base);
    expect(canvasPreviewContinuityKey({
      mediaKind: 'video',
      bindingId: 'project-a',
      projectRelativePath: 'media/other.mp4',
      continuityIdentity: 'sha256:source-a'
    })).not.toBe(base);
    expect(canvasPreviewContinuityKey({
      mediaKind: 'video',
      bindingId: 'project-a',
      projectRelativePath: 'media/clip.mp4',
      continuityIdentity: 'sha256:source-b'
    })).not.toBe(base);
  });

  it('rejects incomplete continuity inputs', () => {
    expect(() => canvasPreviewContinuityKey({
      mediaKind: 'text',
      bindingId: 'project-a',
      projectRelativePath: 'notes/readme.md',
      continuityIdentity: ''
    })).toThrow('Canvas preview continuity identity must be non-empty.');
  });
});
