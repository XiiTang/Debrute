import { describe, expect, it } from 'vitest';
import {
  canvasTextPreviewSourceProjectPath,
  canvasTextPreviewVariantProjectPath
} from './canvasTextPreviews';

describe('Canvas text preview paths', () => {
  it('scopes source cache paths by canvas, project path, and fingerprint', () => {
    expect(canvasTextPreviewSourceProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'sha256:scene-a'
    })).toMatch(
      /^\.debrute\/cache\/canvas-text-previews\/canvas-1\/notes%2Fscene\.md--[a-f0-9]{16}\/sha256%3Ascene-a\/source\.png$/
    );
  });

  it('scopes variant cache paths by source key and width', () => {
    expect(canvasTextPreviewVariantProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'sha256:scene-a',
      width: 590
    })).toMatch(
      /^\.debrute\/cache\/canvas-text-previews\/canvas-1\/notes%2Fscene\.md--[a-f0-9]{16}\/sha256%3Ascene-a\/preview-w590\.png$/
    );
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

  it('rejects invalid variant widths', () => {
    expect(() => canvasTextPreviewVariantProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'sha256:scene-a',
      width: 0
    })).toThrow('Canvas text preview width must be a positive integer.');
  });

});
