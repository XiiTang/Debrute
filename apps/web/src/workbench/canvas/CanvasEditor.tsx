import React from 'react';
import { Boxes } from 'lucide-react';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import type { WorkbenchContextMenuPosition, WorkbenchContextMenuTarget } from '../shell/contextMenu';
import type { CanvasFeedbackBarTarget, CanvasLocalFeedbackDraft, FloatingBarRect } from '../shell/floatingBars';
import { getCanvasById } from '../services/canvasState';
import { CanvasSurface } from './CanvasSurface';
import type { CanvasOverlayRuntime } from './CanvasOverlayRuntime';
import type { CanvasImageFeedbackDraftRegion, CanvasImageFeedbackMode } from './CanvasImageFeedbackLayer';
import type { CanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import { createCanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import { ProjectOpenPanel } from '../project-open/ProjectOpenPanel';

export function CanvasEditor({
  canvasId,
  state,
  actions,
  runtimeScopeKey,
  overlayRuntime,
  minimapOpen,
  feedbackPlacementContext,
  onCurrentNodesChange,
  onFeedbackBarTargetChange,
  onRuntimeChange,
  onOpenContextMenu,
  localFeedbackMode,
  pendingFeedbackRegion,
  onLocalFeedbackDraft
}: {
  canvasId: string | undefined;
  state: WorkbenchState;
  actions: WorkbenchActions;
  runtimeScopeKey?: number;
  overlayRuntime: CanvasOverlayRuntime;
  minimapOpen?: boolean | undefined;
  feedbackPlacementContext: {
    viewportRect: FloatingBarRect;
    reservedRects: readonly FloatingBarRect[];
  };
  onCurrentNodesChange?: ((canvasId: string, nodes: ProjectedCanvasNode[] | undefined) => void) | undefined;
  onFeedbackBarTargetChange?: ((target: CanvasFeedbackBarTarget | undefined) => void) | undefined;
  onRuntimeChange?: ((runtime: CanvasEditorRuntime | undefined) => void) | undefined;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  localFeedbackMode?: CanvasImageFeedbackMode | undefined;
  pendingFeedbackRegion?: { projectRelativePath: string } & CanvasImageFeedbackDraftRegion | undefined;
  onLocalFeedbackDraft?: ((input: CanvasLocalFeedbackDraft) => void) | undefined;
}): React.ReactElement {
  const canvas = getCanvasById(state.snapshot, canvasId);
  const projection = state.snapshot?.projections.find((item) => item.canvasId === canvas?.id);
  const runtimeKey = canvas && projection
    ? `${canvas.id}\u001f${projection.canvasId}\u001f${runtimeScopeKey ?? 0}`
    : undefined;
  const [runtimeState, setRuntimeState] = React.useState<{
    key: string;
    runtime: CanvasEditorRuntime;
  }>();
  const runtime = runtimeState && runtimeState.key === runtimeKey ? runtimeState.runtime : undefined;

  React.useEffect(() => {
    if (!canvas || !projection) {
      onFeedbackBarTargetChange?.(undefined);
      onRuntimeChange?.(undefined);
    }
  }, [canvas, onFeedbackBarTargetChange, onRuntimeChange, projection]);

  React.useEffect(() => {
    if (!runtimeKey) {
      setRuntimeState(undefined);
      onRuntimeChange?.(undefined);
      return;
    }
    const nextRuntime = createCanvasEditorRuntime();
    setRuntimeState({
      key: runtimeKey,
      runtime: nextRuntime
    });
    onRuntimeChange?.(nextRuntime);
    return () => {
      onRuntimeChange?.(undefined);
      nextRuntime.dispose();
    };
  }, [onRuntimeChange, runtimeKey]);

  if (!canvas || !projection) {
    return <EmptyCanvas hasProject={Boolean(state.snapshot)} state={state} actions={actions} />;
  }

  if (!runtime) {
    return <section className="canvas-shell" data-testid="canvas-runtime-loading" />;
  }

  return (
    <section className="canvas-shell">
      <CanvasSurface
        canvas={canvas}
        projection={projection}
        runtime={runtime}
        actions={actions}
        textFileBuffers={state.textFileBuffers}
        canvasFeedback={state.canvasFeedback}
        localFeedbackMode={localFeedbackMode}
        pendingFeedbackRegion={pendingFeedbackRegion}
        onLocalFeedbackDraft={onLocalFeedbackDraft}
        overlayRuntime={overlayRuntime}
        minimapOpen={minimapOpen}
        feedbackPlacementContext={feedbackPlacementContext}
        onCurrentNodesChange={onCurrentNodesChange}
        onFeedbackBarTargetChange={onFeedbackBarTargetChange}
        onOpenContextMenu={onOpenContextMenu}
        textPreviewStyleDependencyKey={state.resolvedTheme}
      />
    </section>
  );
}

function EmptyCanvas({
  hasProject,
  state,
  actions
}: {
  hasProject: boolean;
  state: WorkbenchState;
  actions: WorkbenchActions;
}): React.ReactElement {
  if (!hasProject) {
    return (
      <div className="empty-editor empty-project">
        <ProjectOpenPanel
          attemptedPath={state.projectOpen.attemptedPath}
          error={state.projectOpen.error}
          opening={state.projectOpen.opening}
          onOpenProject={() => { void actions.openProject(); }}
        />
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
