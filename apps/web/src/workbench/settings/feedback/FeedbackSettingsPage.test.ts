import { describe, expect, it } from 'vitest';
import { feedbackNameError } from './FeedbackSettingsPage.js';

describe('feedbackNameError', () => {
  it('uses the exact Unicode sequence as identity without trimming or normalization', () => {
    const configured = new Set(['喜欢', 'é', ' like ']);
    expect(feedbackNameError('喜欢', configured)).toBe('duplicate');
    expect(feedbackNameError('e\u0301', configured)).toBeUndefined();
    expect(feedbackNameError('like', configured)).toBeUndefined();
    expect(feedbackNameError(' like ', configured)).toBe('duplicate');
    expect(feedbackNameError('👨‍👩‍👧‍👦'.repeat(32), new Set())).toBeUndefined();
    expect(feedbackNameError('👨‍👩‍👧‍👦'.repeat(33), new Set())).toBe('too-long');
  });

  it('allows natural RTL and joiners while rejecting configuration control characters', () => {
    expect(feedbackNameError('أحب', new Set())).toBeUndefined();
    expect(feedbackNameError('می\u200cخواهم', new Set())).toBeUndefined();
    expect(feedbackNameError('family\u200dname', new Set())).toBeUndefined();
    expect(feedbackNameError('line\nfeed', new Set())).toBe('forbidden-control');
    expect(feedbackNameError('hidden\u202ereorder', new Set())).toBe('forbidden-control');
  });
});
