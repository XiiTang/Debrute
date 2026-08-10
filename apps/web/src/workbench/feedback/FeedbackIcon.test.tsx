import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FeedbackIcon, resolvedFeedbackIconIdentifier } from './FeedbackIcon.js';

describe('FeedbackIcon', () => {
  it('uses Phosphor canonical identifiers and falls back for unknown local mappings', () => {
    expect(resolvedFeedbackIconIdentifier('heart')).toBe('heart');
    expect(resolvedFeedbackIconIdentifier('removed-in-another-version')).toBe('question');
    expect(renderToStaticMarkup(<FeedbackIcon icon="removed-in-another-version" />))
      .toContain('data-feedback-icon="question"');
  });
});
