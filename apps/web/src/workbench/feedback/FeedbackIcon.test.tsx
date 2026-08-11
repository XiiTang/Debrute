import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FeedbackIcon, resolvedFeedbackIconIdentifier } from './FeedbackIcon.js';
import { FEEDBACK_ICON_MANIFEST } from './generatedFeedbackIconManifest.js';
import {
  FEEDBACK_ICON_NAMES,
  UNRESOLVED_FEEDBACK_ICON_NAME
} from './generatedFeedbackIconNames.js';

describe('FeedbackIcon', () => {
  it('reserves one resolvable but non-configurable icon for unknown local mappings', () => {
    expect(UNRESOLVED_FEEDBACK_ICON_NAME).toBe('question');
    expect(FEEDBACK_ICON_NAMES).toContain(UNRESOLVED_FEEDBACK_ICON_NAME);
    expect(FEEDBACK_ICON_MANIFEST.map(({ name }) => name))
      .not.toContain(UNRESOLVED_FEEDBACK_ICON_NAME);
    expect(resolvedFeedbackIconIdentifier('heart')).toBe('heart');
    expect(resolvedFeedbackIconIdentifier('removed-in-another-version'))
      .toBe(UNRESOLVED_FEEDBACK_ICON_NAME);
    expect(renderToStaticMarkup(<FeedbackIcon icon="removed-in-another-version" />))
      .toContain(`data-feedback-icon="${UNRESOLVED_FEEDBACK_ICON_NAME}"`);
  });
});
