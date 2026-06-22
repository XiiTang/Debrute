import { describe, expect, it } from 'vitest';
import { isIgnoredProjectFilePath } from './projectPaths';
import { normalizeFileWatchEvent } from './index';

describe('project path ignore rules', () => {
  it('ignores rendered Canvas feedback artifacts', () => {
    expect(isIgnoredProjectFilePath('.debrute/reviews/rendered-feedback')).toBe(true);
    expect(isIgnoredProjectFilePath('.debrute/reviews/rendered-feedback/assets/page.png.annotated.png')).toBe(true);
    expect(isIgnoredProjectFilePath('.debrute/reviews/canvas-feedback.json')).toBe(false);
    expect(isIgnoredProjectFilePath('assets/page.png')).toBe(false);
  });

  it('classifies Canvas feedback document changes separately from source content', () => {
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/reviews/canvas-feedback.json', 'changed').affects).toEqual([
      'canvas-feedback'
    ]);
  });
});
