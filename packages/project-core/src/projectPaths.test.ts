import { describe, expect, it } from 'vitest';
import {
  assertProjectTreeVisibleMutationPath,
  isProjectVisiblePath
} from './projectPaths';
import { normalizeFileWatchEvent } from './index';

describe('project path ignore rules', () => {
  it('ignores rendered Canvas feedback artifacts', () => {
    expect(isProjectVisiblePath('.debrute/reviews/rendered-feedback')).toBe(false);
    expect(isProjectVisiblePath('.debrute/reviews/rendered-feedback/assets/page.png.annotated.png')).toBe(false);
    expect(isProjectVisiblePath('.debrute/reviews/canvas-feedback.json')).toBe(true);
    expect(isProjectVisiblePath('assets/page.png')).toBe(true);
  });

  it('ignores Canvas text preview artifacts', () => {
    expect(isProjectVisiblePath('.debrute/cache/canvas-text-previews')).toBe(false);
    expect(isProjectVisiblePath('.debrute/cache/canvas-text-previews/canvas-1/notes%2Fa.md--1234567890abcdef/source.png')).toBe(false);
    expect(isProjectVisiblePath('.debrute/cache/canvas-text-previews/canvas-1/notes%2Fa.md--1234567890abcdef/preview-w700.png')).toBe(false);
  });

  it('ignores Canvas video preview artifacts', () => {
    expect(isProjectVisiblePath('.debrute/cache/canvas-video-previews')).toBe(false);
    expect(isProjectVisiblePath('.debrute/cache/canvas-video-previews/canvas-1/media%2Fclip.mp4--123/video-rev/initial-poster/source.jpg')).toBe(false);
    expect(isProjectVisiblePath('.debrute/cache/canvas-video-previews/canvas-1/media%2Fclip.mp4--123/video-rev/playback-frame/preview-w700.jpg')).toBe(false);
  });

  it('ignores the complete Debrute cache and only Debrute-managed temporary files', () => {
    expect(isProjectVisiblePath('.debrute/cache')).toBe(false);
    expect(isProjectVisiblePath('.debrute/cache/file-fingerprints.json')).toBe(false);
    expect(isProjectVisiblePath('notes/a.md.123e4567-e89b-42d3-a456-426614174000.tmp')).toBe(false);
    expect(isProjectVisiblePath('notes/a.md.123e4567-e89b-42d3-a456-426614174000.restore.tmp')).toBe(false);
    expect(isProjectVisiblePath('notes/.debrute-upload-123e4567-e89b-42d3-a456-426614174000.tmp')).toBe(false);
    expect(isProjectVisiblePath('notes/.debrute-adobe-transfer-123e4567-e89b-42d3-a456-426614174000.tmp')).toBe(false);
    expect(isProjectVisiblePath('.debrute/settings.lock/inside.md')).toBe(false);
    expect(isProjectVisiblePath('notes/a.md.123e4567-e89b-42d3-a456-426614174000.tmp/inside.md')).toBe(false);
    expect(isProjectVisiblePath('notes.tmp')).toBe(true);
    expect(isProjectVisiblePath('notes/draft.tmp')).toBe(true);
  });

  it('reserves project-internal path namespaces case-insensitively', () => {
    expect(() => assertProjectTreeVisibleMutationPath('.GIT/config'))
      .toThrow('Project path is not visible in the Project Tree');
    expect(() => assertProjectTreeVisibleMutationPath('.DeBrute/canvases/index.json'))
      .toThrow('Project path is protected by the Project Document System');
    expect(isProjectVisiblePath('.DeBrute/cache/canvas-image-previews')).toBe(false);
    expect(isProjectVisiblePath('.DeBrute/cache/canvas-text-previews/canvas-1/preview.png')).toBe(false);
    expect(isProjectVisiblePath('.DeBrute/reviews/rendered-feedback/page.png.annotated.png')).toBe(false);
    expect(isProjectVisiblePath('.DeBrute/project.lock')).toBe(false);
    expect(() => assertProjectTreeVisibleMutationPath('.debrute-not-internal/file.md')).not.toThrow();
  });

  it('classifies Canvas feedback document changes separately from source content', () => {
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/reviews/canvas-feedback.json', 'changed').affects).toEqual([
      'canvas-feedback'
    ]);
  });
});
