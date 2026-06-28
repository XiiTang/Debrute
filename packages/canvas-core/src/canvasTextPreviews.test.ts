import { describe, expect, it } from 'vitest';
import {
  canvasTextPreviewDescriptorProjectPath,
  canvasTextPreviewSourceProjectPath,
  canvasTextPreviewVariantProjectPath,
  normalizeCanvasTextPreviewDescriptor
} from './canvasTextPreviews';

describe('Canvas text preview paths', () => {
  it('maps a Canvas text file to source, variant, and descriptor paths through a source key', () => {
    const target = {
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'sha256:scene-a'
    };
    const sourcePath = canvasTextPreviewSourceProjectPath(target);
    expect(sourcePath).toMatch(
      /^\.debrute\/cache\/canvas-text-previews\/canvas-1\/notes%2Fscene\.md--[a-f0-9]{16}\/sha256%3Ascene-a\/source\.png$/
    );

    const variantPath = canvasTextPreviewVariantProjectPath({
      ...target,
      width: 700
    });
    expect(variantPath).toBe(sourcePath.replace('/source.png', '/preview-w700.png'));

    const descriptorPath = canvasTextPreviewDescriptorProjectPath(target);
    expect(descriptorPath).toBe(sourcePath.replace('/source.png', '/preview.json'));
  });

  it('rejects unsafe canvas ids and internal project paths', () => {
    expect(() => canvasTextPreviewSourceProjectPath({
      canvasId: '../canvas',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a'
    })).toThrow('Canvas text preview canvas id must be a valid id.');

    expect(() => canvasTextPreviewSourceProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: '.debrute/cache/file.md',
      fingerprint: 'fingerprint-a'
    })).toThrow('Canvas text preview cannot target Debrute internal files.');

    expect(() => canvasTextPreviewSourceProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes\\scene.md',
      fingerprint: 'fingerprint-a'
    })).toThrow('Project path must not contain backslashes');

    expect(() => canvasTextPreviewSourceProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: './notes/scene.md',
      fingerprint: 'fingerprint-a'
    })).toThrow('Project path must not contain "." or ".." segments');

    expect(() => canvasTextPreviewSourceProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: ''
    })).toThrow('Canvas text preview fingerprint must be a non-empty string.');
  });

  it('normalizes descriptors with sorted positive widths', () => {
    expect(normalizeCanvasTextPreviewDescriptor({
      fingerprint: 'fp',
      sourceWidth: 1200,
      sourceHeight: 640,
      contentCssWidth: 600,
      contentCssHeight: 320,
      scrollTop: 0,
      scrollLeft: 0,
      variants: [700, 350, 700]
    })).toEqual({
      fingerprint: 'fp',
      sourceWidth: 1200,
      sourceHeight: 640,
      contentCssWidth: 600,
      contentCssHeight: 320,
      scrollTop: 0,
      scrollLeft: 0,
      variants: [350, 700]
    });
  });
});
