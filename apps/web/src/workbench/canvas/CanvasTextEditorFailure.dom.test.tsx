import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CanvasTextEditor } from './CanvasTextEditor.js';
import { CanvasTextRenderProfileGate } from './CanvasTextRenderProfileContext.js';
import { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } from './CanvasTextRenderProfile.test-support.js';

const languageMock = vi.hoisted(() => ({
  load: vi.fn()
}));

vi.mock('./textEditorCodeMirrorLanguages.js', () => ({
  loadCodeMirrorLanguageExtensionForProjectTextLanguage: languageMock.load
}));

vi.mock('./font-subset/CanvasTextProjectFontEnvironment.js', () => ({
  useCanvasTextProjectFontEnvironment: () => ({
    prepareInteractive: async () => undefined,
    activeInteractiveProfile: DEFAULT_CANVAS_TEXT_RENDER_PROFILE
  })
}));

beforeEach(() => {
  languageMock.load.mockReset();
});

describe('CanvasTextEditor activation failures', { tags: ['canvas-text'] }, () => {
  it('reports a language extension failure instead of waiting forever for layout readiness', async () => {
    const failure = new Error('language chunk unavailable');
    languageMock.load.mockRejectedValue(failure);
    const onLayoutReady = vi.fn();
    const onLayoutFailure = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <CanvasTextRenderProfileGate profile={DEFAULT_CANVAS_TEXT_RENDER_PROFILE} pending={null}>
            <CanvasTextEditor
              value="# Notes"
              language="markdown"
              wordWrap={false}
              onChange={() => undefined}
              onSave={() => undefined}
              onToggleWordWrap={() => undefined}
              onLayoutReady={onLayoutReady}
              onLayoutFailure={onLayoutFailure}
            />
          </CanvasTextRenderProfileGate>
        );
        await Promise.resolve();
      });

      expect(onLayoutReady).not.toHaveBeenCalled();
      expect(onLayoutFailure).toHaveBeenCalledOnce();
      expect(onLayoutFailure).toHaveBeenCalledWith(failure);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
