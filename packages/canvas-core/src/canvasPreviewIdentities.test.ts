import { describe, expect, it } from 'vitest';
import {
  canvasPreviewTargetIdentity,
  canvasPreviewTargetIdentityFromDigest,
  canvasPreviewTargetKey,
  canvasPreviewVariantIdentity,
  canvasPreviewVariantKey
} from './canvasPreviewIdentities';

describe('Canvas preview identities', () => {
  it('keeps pixel identity independent from Canvas and Project ownership', () => {
    const targetIdentity = canvasPreviewTargetIdentity(['sha256:source', 'frame-v1--ms-1250']);
    const projectATargetKey = canvasPreviewTargetKey({
      mediaKind: 'video',
      bindingId: 'project-a',
      projectRelativePath: 'clips/a.mp4',
      targetIdentity
    });

    expect(projectATargetKey).not.toBe(canvasPreviewTargetKey({
      mediaKind: 'video',
      bindingId: 'project-b',
      projectRelativePath: 'clips/a.mp4',
      targetIdentity
    }));
    expect(projectATargetKey).not.toBe(canvasPreviewTargetKey({
      mediaKind: 'video',
      bindingId: 'project-a',
      projectRelativePath: 'clips/b.mp4',
      targetIdentity
    }));
  });

  it('changes a variant identity only for its target pixels and width', () => {
    const targetIdentity = canvasPreviewTargetIdentity(['sha256:source', 1250]);
    const base = canvasPreviewVariantIdentity({
      targetIdentity,
      width: 1024
    });

    expect(canvasPreviewVariantIdentity({
      targetIdentity,
      width: 2048
    })).not.toBe(base);
    expect(canvasPreviewVariantIdentity({
      targetIdentity: canvasPreviewTargetIdentity(['sha256:other-source', 1250]),
      width: 1024
    })).not.toBe(base);
  });

  it('scopes the same variant identity without changing it', () => {
    const targetIdentity = canvasPreviewTargetIdentityFromDigest('sha256:text-target');
    expect(canvasPreviewVariantKey({
      mediaKind: 'text',
      bindingId: 'project-a',
      projectRelativePath: 'notes/a.md',
      targetIdentity,
      width: 800
    })).not.toBe(canvasPreviewVariantKey({
      mediaKind: 'text',
      bindingId: 'project-a',
      projectRelativePath: 'notes/b.md',
      targetIdentity,
      width: 800
    }));
  });

  it('rejects empty identities and invalid widths', () => {
    expect(() => canvasPreviewTargetIdentity([])).toThrow(
      'Canvas preview target identity must include at least one part.'
    );
    expect(() => canvasPreviewTargetIdentityFromDigest('')).toThrow(
      'Canvas preview target identity digest must be non-empty.'
    );
    expect(() => canvasPreviewVariantIdentity({
      targetIdentity: canvasPreviewTargetIdentity(['source']),
      width: 0
    })).toThrow('Canvas preview variant width must be a positive integer.');
    expect(() => canvasPreviewTargetKey({
      mediaKind: 'image',
      bindingId: '',
      projectRelativePath: 'images/a.png',
      targetIdentity: canvasPreviewTargetIdentityFromDigest('sha256:image')
    })).toThrow('Canvas preview Binding ID must be non-empty.');
  });
});
