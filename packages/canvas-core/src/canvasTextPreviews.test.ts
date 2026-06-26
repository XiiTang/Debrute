import { describe, expect, it } from 'vitest';
import {
  canvasTextPreviewDescriptorProjectPath,
  canvasTextPreviewSourceProjectPath,
  canvasTextPreviewVariantProjectPath,
  normalizeCanvasTextPreviewDescriptor
} from './canvasTextPreviews';

describe('Canvas text preview paths', () => {
  it('maps a Canvas text file to source, variant, and descriptor paths through a source key', () => {
    const sourcePath = canvasTextPreviewSourceProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md'
    });
    expect(sourcePath).toMatch(
      /^\.debrute\/cache\/canvas-text-previews\/canvas-1\/notes%2Fscene\.md--[a-f0-9]{16}\/source\.png$/
    );

    const variantPath = canvasTextPreviewVariantProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      width: 700
    });
    expect(variantPath).toBe(sourcePath.replace('/source.png', '/preview-w700.png'));

    const descriptorPath = canvasTextPreviewDescriptorProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md'
    });
    expect(descriptorPath).toBe(sourcePath.replace('/source.png', '/preview.json'));
  });

  it('rejects unsafe canvas ids and internal project paths', () => {
    expect(() => canvasTextPreviewSourceProjectPath({
      canvasId: '../canvas',
      projectRelativePath: 'notes/scene.md'
    })).toThrow('Canvas text preview canvas id must be a valid id.');

    expect(() => canvasTextPreviewSourceProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: '.debrute/cache/file.md'
    })).toThrow('Canvas text preview cannot target Debrute internal files.');

    expect(() => canvasTextPreviewSourceProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes\\scene.md'
    })).toThrow('Project path must not contain backslashes');

    expect(() => canvasTextPreviewSourceProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: './notes/scene.md'
    })).toThrow('Project path must not contain "." or ".." segments');
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
