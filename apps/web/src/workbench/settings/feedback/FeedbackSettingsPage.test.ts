import { describe, expect, it } from 'vitest';
import { feedbackNamePreflightError } from './FeedbackSettingsPage.js';

describe('feedbackNamePreflightError', () => {
  it('rejects only an empty or exact duplicate name before Runtime validation', () => {
    const configured = new Set(['喜欢', 'é', ' like ']);
    expect(feedbackNamePreflightError('', configured)).toBe('required');
    expect(feedbackNamePreflightError('喜欢', configured)).toBe('duplicate');
    expect(feedbackNamePreflightError('e\u0301', configured)).toBeUndefined();
    expect(feedbackNamePreflightError('like', configured)).toBeUndefined();
    expect(feedbackNamePreflightError(' like ', configured)).toBe('duplicate');
    expect(feedbackNamePreflightError('👨‍👩‍👧‍👦'.repeat(32), new Set())).toBeUndefined();
    expect(feedbackNamePreflightError('👨‍👩‍👧‍👦'.repeat(33), new Set())).toBeUndefined();
    expect(feedbackNamePreflightError('أحب', new Set())).toBeUndefined();
    expect(feedbackNamePreflightError('می\u200cخواهم', new Set())).toBeUndefined();
    expect(feedbackNamePreflightError('family\u200dname', new Set())).toBeUndefined();
    expect(feedbackNamePreflightError('line\nfeed', new Set())).toBeUndefined();
    expect(feedbackNamePreflightError('hidden\u202ereorder', new Set())).toBeUndefined();
  });
});
