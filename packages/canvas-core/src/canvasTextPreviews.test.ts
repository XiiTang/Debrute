import { describe, expect, it } from 'vitest';
import {
  canvasTextPreviewDescriptorProjectPath,
  canvasTextPreviewSourceProjectPath,
  canvasTextPreviewVariantProjectPath,
  normalizeCanvasTextPreviewDescriptor
} from './canvasTextPreviews';

describe('Canvas text preview paths', () => {
  it('maps a Canvas text file to source, variant, and descriptor paths', () => {
    expect(canvasTextPreviewSourceProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md'
    })).toBe('.debrute/cache/canvas-text-previews/canvas-1/notes/scene.md.source.png');

    expect(canvasTextPreviewVariantProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      width: 700
    })).toBe('.debrute/cache/canvas-text-previews/canvas-1/notes/scene.md.preview-w700.png');

    expect(canvasTextPreviewDescriptorProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md'
    })).toBe('.debrute/cache/canvas-text-previews/canvas-1/notes/scene.md.preview.json');
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
