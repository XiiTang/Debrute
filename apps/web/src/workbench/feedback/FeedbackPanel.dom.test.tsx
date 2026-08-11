import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { CanvasFeedbackDocument } from '@debrute/app-protocol';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/index';
import { FeedbackPanel } from './FeedbackPanel';

describe('FeedbackPanel', () => {
  it('locates the Project root, identifies unresolved paths, and falls back for unmapped names', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onLocatePath = vi.fn();
    const onClearMark = vi.fn(async () => false);
    const feedback = feedbackFixture(['', 'missing.png']);
    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <FeedbackPanel
              feedback={feedback}
              catalog={[]}
              projectTree={[{ projectRelativePath: 'available.png', kind: 'file' }]}
              onLocatePath={onLocatePath}
              onClearMark={onClearMark}
              onDeleteItem={async () => true}
            />
          </I18nProvider>
        );
      });

      const pathButtons = [...container.querySelectorAll<HTMLButtonElement>('.feedback-panel__path')];
      expect(pathButtons[0]?.disabled).toBe(false);
      expect(pathButtons[1]?.disabled).toBe(true);
      expect(pathButtons[1]?.textContent).toContain('Location unavailable');
      expect(container.querySelectorAll('[data-feedback-icon="question"]')).toHaveLength(2);

      await act(async () => { pathButtons[0]?.click(); });
      expect(onLocatePath).toHaveBeenCalledWith('');

      const clearButton = container.querySelector<HTMLButtonElement>('[aria-label="Clear feedback mark"]');
      await act(async () => { clearButton?.click(); });
      expect(onClearMark).toHaveBeenCalledWith('', 'not configured');
      expect(clearButton?.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

function feedbackFixture(paths: string[]): CanvasFeedbackDocument {
  return {
    updatedAt: '2026-08-10T00:00:00Z',
    entries: Object.fromEntries(paths.map((path) => [path, {
      projectRelativePath: path,
      marks: ['not configured'],
      nextMomentLabel: 1,
      nextSpatialLabel: 1,
      items: [],
      updatedAt: '2026-08-10T00:00:00Z'
    }]))
  };
}
