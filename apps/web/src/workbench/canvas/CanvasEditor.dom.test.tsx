import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasProjection } from './CanvasScene.js';
import type { CanvasEditorActions } from './CanvasSceneActions.js';
import { CanvasEditor } from './CanvasEditor.js';

const canvasState = { expandedDirectories: [], nodeStates: {}, occlusionOrder: [] };

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
    const projection: CanvasProjection = {
      nodes: [],
      edges: []
    };
    const textFileBuffers = {};

    try {
      await act(async () => {
        root.render(
          <CanvasEditor
            canvas={{ expandedDirectories: canvasState.expandedDirectories, projection }}
            hasProject
            projectOpening={false}
            recentProjectRoots={[]}
            onOpenRecentProject={async () => undefined}
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
            canvas={{ expandedDirectories: canvasState.expandedDirectories, projection }}
            hasProject
            projectOpenError="unrelated project-open presentation update"
            projectOpening={false}
            recentProjectRoots={[]}
            onOpenRecentProject={async () => undefined}
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

const actions: CanvasEditorActions = {
  resolveCanvasSources: async () => ({ sources: [] }),
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
  setCanvasDirectoryExpanded: async () => undefined,
  raiseCanvasSelection: async () => undefined,
  openProject: async () => undefined
};
