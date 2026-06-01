import React from 'react';
import { Boxes, FolderTree } from 'lucide-react';
import type { CanvasDocument } from '@axis/canvas-core';
import type { ProjectSessionSnapshot } from '@axis/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import type { WorkbenchContextMenuPosition, WorkbenchContextMenuTarget } from '../shell/contextMenu';
import type { CanvasFeedbackBarTarget } from '../shell/floatingBars';
import { CanvasSurface } from './CanvasSurface';
import type { CanvasNavigationState } from './canvasMinimap';

export function CanvasEditor({
  canvasId,
  state,
  actions,
  onFeedbackBarTargetChange,
  onNavigationStateChange,
  onOpenContextMenu
}: {
  canvasId: string | undefined;
  state: WorkbenchState;
  actions: WorkbenchActions;
  onFeedbackBarTargetChange?: ((target: CanvasFeedbackBarTarget | undefined) => void) | undefined;
  onNavigationStateChange?: ((state: CanvasNavigationState | undefined) => void) | undefined;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
}): React.ReactElement {
  const canvas = getCanvasById(state.snapshot, canvasId);
  const projection = state.snapshot?.projections.find((item) => item.canvasId === canvas?.id);

  React.useEffect(() => {
    if (!canvas || !projection) {
      onFeedbackBarTargetChange?.(undefined);
      onNavigationStateChange?.(undefined);
    }
  }, [canvas, onFeedbackBarTargetChange, onNavigationStateChange, projection]);

  if (!canvas || !projection) {
    return <EmptyCanvas hasProject={Boolean(state.snapshot)} actions={actions} />;
  }

  if (!state.canvasSettings) {
    return <section className="canvas-shell" data-testid="canvas-settings-loading" />;
  }

  return (
    <section className="canvas-shell">
      <CanvasSurface
        canvas={canvas}
        projection={projection}
        actions={actions}
        selection={state.selection}
        textFileBuffers={state.textFileBuffers}
        textEditorWindows={state.textEditorWindows}
        canvasFeedback={state.canvasFeedback}
        canvasSettings={state.canvasSettings}
        onFeedbackBarTargetChange={onFeedbackBarTargetChange}
        onNavigationStateChange={onNavigationStateChange}
        onOpenContextMenu={onOpenContextMenu}
      />
    </section>
  );
}

function EmptyCanvas({ hasProject, actions }: { hasProject: boolean; actions: WorkbenchActions }): React.ReactElement {
  if (!hasProject) {
    return (
      <div className="empty-editor empty-project">
        <Boxes size={34} />
        <strong>No project open</strong>
        <button type="button" className="empty-action" onClick={actions.openProject}>
          <FolderTree size={15} />
          Open Project
        </button>
      </div>
    );
  }
  return (
    <div className="empty-editor">
      <Boxes size={34} />
      <span>No canvas available.</span>
    </div>
  );
}

function getCanvasById(snapshot: ProjectSessionSnapshot | undefined, canvasId: string | undefined): CanvasDocument | undefined {
  return snapshot?.canvases.find((canvas) => canvas.id === canvasId) ?? snapshot?.canvases[0];
}
