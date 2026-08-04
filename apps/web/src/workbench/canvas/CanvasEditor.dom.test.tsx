import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasDocument, CanvasProjection } from '@debrute/canvas-core';
import type { CanvasEditorActions } from './CanvasSceneActions.js';
import { CanvasEditor } from './CanvasEditor.js';

const { canvasSurfaceRenderSpy } = vi.hoisted(() => ({
  canvasSurfaceRenderSpy: vi.fn()
}));

vi.mock('./CanvasSurface.js', () => ({
  CanvasSurface: () => {
    canvasSurfaceRenderSpy();
    return <div data-testid="canvas-surface-stub" />;
  }
}));

describe('CanvasEditor', () => {
  afterEach(() => {
    canvasSurfaceRenderSpy.mockReset();
  });

  it('does not rerender the Canvas scene for unrelated Workbench presentation changes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const canvas = canvasFixture('memoized-scene');
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [],
      edges: [],
      diagnostics: []
    };
    const textFileBuffers = {};

    try {
      await act(async () => {
        root.render(
          <CanvasEditor
            canvas={canvas}
            projection={projection}
            hasProject
            projectOpening={false}
            actions={actions}
            textFileBuffers={textFileBuffers}
            canvasFeedback={undefined}
            textPreviewStyleDependencyKey="dark"
            productPlatform="darwin"
          />
        );
      });
      const initialSceneRenderCount = canvasSurfaceRenderSpy.mock.calls.length;
      expect(initialSceneRenderCount).toBeGreaterThan(0);

      await act(async () => {
        root.render(
          <CanvasEditor
            canvas={canvas}
            projection={projection}
            hasProject
            projectOpenError="unrelated project-open presentation update"
            projectOpening={false}
            actions={actions}
            textFileBuffers={textFileBuffers}
            canvasFeedback={undefined}
            textPreviewStyleDependencyKey="dark"
            productPlatform="darwin"
          />
        );
      });

      expect(canvasSurfaceRenderSpy).toHaveBeenCalledTimes(initialSceneRenderCount);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});

function canvasFixture(id: string): CanvasDocument {
  return {
    id,
    name: id,
    nodeElements: [],
    annotations: [],
    preferences: { showDiagnostics: true }
  };
}

const actions: CanvasEditorActions = {
  readProjectTextFile: async () => {
    throw new Error('not used');
  },
  saveCanvasTextPreviewSource: async () => {
    throw new Error('not used');
  },
  readCanvasTextPreviewSources: async () => ({ sources: {} }),
  probeCanvasVideoPreviewSources: async () => ({ sources: {} }),
  ensureCanvasVideoPreviewSource: async () => ({ status: 'failed', message: 'not used' }),
  ensureTextFileBuffer: async () => undefined,
  updateTextFileBuffer: () => undefined,
  saveTextFileBuffer: async () => undefined,
  discardTextFileBuffer: async () => undefined,
  openTextEditorWindow: () => undefined,
  toggleTextFileWordWrap: () => undefined,
  updateCanvasNodeLayouts: async () => undefined,
  updateCanvasVideoPlaybackState: async () => undefined,
  updateCanvasTextViewportState: async () => undefined,
  addProjectPathToCanvasMap: async () => undefined,
  openProject: async () => undefined
};
