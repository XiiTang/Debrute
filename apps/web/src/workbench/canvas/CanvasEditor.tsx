import React from 'react';
import type { DebruteProductPlatform } from '@debrute/app-protocol';
import { Boxes } from '../ui/index.js';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import type { WorkbenchContextMenuPosition, WorkbenchContextMenuTarget } from '../shell/contextMenu';
import { getCanvasById } from '../services/canvasState';
import { CanvasSurface } from './CanvasSurface';
import type { CanvasFeedbackCanvasBinding } from './CanvasFeedbackInteraction';
import type { CanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import { createCanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import { ProjectOpenPanel } from '../project-open/ProjectOpenPanel';

export function CanvasEditor({
  canvasId,
  state,
  actions,
  runtimeScopeKey,
  minimapOpen,
  productPlatform,
  cutPaths,
  onCurrentNodesChange,
  feedbackInteraction,
  onRuntimeChange,
  onOpenContextMenu,
  interactionBlocked = false,
}: {
  canvasId: string | undefined;
  state: WorkbenchState;
  actions: WorkbenchActions;
  runtimeScopeKey?: number;
  minimapOpen?: boolean | undefined;
  productPlatform: DebruteProductPlatform;
  cutPaths?: readonly string[] | undefined;
  onCurrentNodesChange?: ((canvasId: string, nodes: ProjectedCanvasNode[] | undefined) => void) | undefined;
  feedbackInteraction?: CanvasFeedbackCanvasBinding | undefined;
  onRuntimeChange?: ((runtime: CanvasEditorRuntime | undefined) => void) | undefined;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  interactionBlocked?: boolean | undefined;
}): React.ReactElement {
  const canvas = getCanvasById(state.snapshot, canvasId);
  const projection = state.snapshot?.projections.find((item) => item.canvasId === canvas?.id);
  const runtimeKey = canvas && projection
    ? `${canvas.id}\u001f${projection.canvasId}\u001f${runtimeScopeKey ?? 0}`
    : undefined;
  const actionsRef = React.useRef(actions);
  actionsRef.current = actions;
  const runtimeInputRef = React.useRef<Parameters<typeof createCanvasEditorRuntime>[0] | undefined>(undefined);
  runtimeInputRef.current = canvas && projection
    ? {
        canvasId: canvas.id,
        initialProjection: projection,
        submitManualLayout: (mutation) => actionsRef.current.updateCanvasNodeLayouts(canvas.id, {
          interaction: mutation.interaction,
          nodeLayouts: [...mutation.nodeLayouts]
        })
      }
    : undefined;
  const [runtimeState, setRuntimeState] = React.useState<{
    key: string;
    runtime: CanvasEditorRuntime;
  }>();
  const runtime = runtimeState && runtimeState.key === runtimeKey ? runtimeState.runtime : undefined;

  React.useEffect(() => {
    if (!canvas || !projection) {
      feedbackInteraction?.handleTargetChange(undefined);
      onRuntimeChange?.(undefined);
    }
  }, [canvas, feedbackInteraction, onRuntimeChange, projection]);

  React.useEffect(() => {
    const runtimeInput = runtimeInputRef.current;
    if (!runtimeKey || !runtimeInput) {
      setRuntimeState(undefined);
      onRuntimeChange?.(undefined);
      return;
    }
    const nextRuntime = createCanvasEditorRuntime(runtimeInput);
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
        feedbackInteraction={feedbackInteraction}
        minimapOpen={minimapOpen}
        productPlatform={productPlatform}
        cutPaths={cutPaths}
        onCurrentNodesChange={onCurrentNodesChange}
        onOpenContextMenu={onOpenContextMenu}
        interactionBlocked={interactionBlocked}
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
