import React from 'react';
import type { DebruteProductPlatform } from '@debrute/app-protocol';
import { Boxes } from '../ui/index.js';
import type {
  CanvasDocument,
  CanvasFeedbackDocument,
  CanvasProjection
} from '@debrute/canvas-core';
import type { TextFileBuffer } from '../../types';
import type { WorkbenchContextMenuPosition, WorkbenchContextMenuTarget } from '../shell/contextMenu';
import { CanvasSurface } from './CanvasSurface';
import type { CanvasFeedbackCanvasBinding } from './CanvasFeedbackInteraction';
import type { CanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import { createCanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import { ProjectOpenPanel } from '../project-open/ProjectOpenPanel';
import type { CanvasEditorActions, CanvasSceneActions } from './CanvasSceneActions.js';

export function CanvasEditor({
  canvas,
  projection,
  hasProject,
  projectOpenAttemptedPath,
  projectOpenError,
  projectOpening,
  actions,
  textFileBuffers,
  canvasFeedback,
  textPreviewStyleDependencyKey,
  runtimeScopeKey,
  minimapOpen,
  productPlatform,
  cutPaths,
  feedbackInteraction,
  onRuntimeChange,
  onOpenContextMenu,
  interactionBlocked = false,
}: {
  canvas: CanvasDocument | undefined;
  projection: CanvasProjection | undefined;
  hasProject: boolean;
  projectOpenAttemptedPath?: string | undefined;
  projectOpenError?: string | undefined;
  projectOpening: boolean;
  actions: CanvasEditorActions;
  textFileBuffers: Record<string, TextFileBuffer>;
  canvasFeedback: CanvasFeedbackDocument | undefined;
  textPreviewStyleDependencyKey: string;
  runtimeScopeKey?: number;
  minimapOpen?: boolean | undefined;
  productPlatform: DebruteProductPlatform;
  cutPaths?: readonly string[] | undefined;
  feedbackInteraction?: CanvasFeedbackCanvasBinding | undefined;
  onRuntimeChange?: ((runtime: CanvasEditorRuntime | undefined) => void) | undefined;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  interactionBlocked?: boolean | undefined;
}): React.ReactElement {
  React.useEffect(() => {
    if (!canvas || !projection) {
      feedbackInteraction?.handleTargetChange(undefined);
      onRuntimeChange?.(undefined);
    }
  }, [canvas, feedbackInteraction, onRuntimeChange, projection]);

  if (!canvas || !projection) {
    return (
      <EmptyCanvas
        hasProject={hasProject}
        attemptedPath={projectOpenAttemptedPath}
        error={projectOpenError}
        opening={projectOpening}
        onOpenProject={actions.openProject}
      />
    );
  }

  return (
    <CanvasScene
      canvas={canvas}
      projection={projection}
      actions={actions}
      textFileBuffers={textFileBuffers}
      canvasFeedback={canvasFeedback}
      textPreviewStyleDependencyKey={textPreviewStyleDependencyKey}
      runtimeScopeKey={runtimeScopeKey}
      minimapOpen={minimapOpen}
      productPlatform={productPlatform}
      cutPaths={cutPaths}
      feedbackInteraction={feedbackInteraction}
      onRuntimeChange={onRuntimeChange}
      onOpenContextMenu={onOpenContextMenu}
      interactionBlocked={interactionBlocked}
    />
  );
}

interface CanvasSceneProps {
  canvas: CanvasDocument;
  projection: CanvasProjection;
  actions: CanvasSceneActions;
  textFileBuffers: Record<string, TextFileBuffer>;
  canvasFeedback: CanvasFeedbackDocument | undefined;
  textPreviewStyleDependencyKey: string;
  runtimeScopeKey?: number | undefined;
  minimapOpen?: boolean | undefined;
  productPlatform: DebruteProductPlatform;
  cutPaths?: readonly string[] | undefined;
  feedbackInteraction?: CanvasFeedbackCanvasBinding | undefined;
  onRuntimeChange?: ((runtime: CanvasEditorRuntime | undefined) => void) | undefined;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  interactionBlocked?: boolean | undefined;
}

const CanvasScene = React.memo(function CanvasScene({
  canvas,
  projection,
  actions,
  textFileBuffers,
  canvasFeedback,
  textPreviewStyleDependencyKey,
  runtimeScopeKey,
  minimapOpen,
  productPlatform,
  cutPaths,
  feedbackInteraction,
  onRuntimeChange,
  onOpenContextMenu,
  interactionBlocked = false
}: CanvasSceneProps): React.ReactElement {
  const runtimeKey = `${canvas.id}\u001f${projection.canvasId}\u001f${runtimeScopeKey ?? 0}`;
  const actionsRef = React.useRef(actions);
  actionsRef.current = actions;
  const runtimeInput: Parameters<typeof createCanvasEditorRuntime>[0] = {
    canvasId: canvas.id,
    initialProjection: projection,
    submitManualLayout: (mutation) => actionsRef.current.updateCanvasNodeLayouts(canvas.id, {
      interaction: mutation.interaction,
      nodeLayouts: [...mutation.nodeLayouts]
    })
  };
  const runtimeInputRef = React.useRef(runtimeInput);
  runtimeInputRef.current = runtimeInput;
  const [runtimeState, setRuntimeState] = React.useState<{
    key: string;
    runtime: CanvasEditorRuntime;
  }>();
  const runtime = runtimeState && runtimeState.key === runtimeKey ? runtimeState.runtime : undefined;

  React.useEffect(() => {
    const nextRuntime = createCanvasEditorRuntime(runtimeInputRef.current);
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
        textFileBuffers={textFileBuffers}
        canvasFeedback={canvasFeedback}
        feedbackInteraction={feedbackInteraction}
        minimapOpen={minimapOpen}
        productPlatform={productPlatform}
        cutPaths={cutPaths}
        onOpenContextMenu={onOpenContextMenu}
        interactionBlocked={interactionBlocked}
        textPreviewStyleDependencyKey={textPreviewStyleDependencyKey}
      />
    </section>
  );
});

function EmptyCanvas({
  hasProject,
  attemptedPath,
  error,
  opening,
  onOpenProject
}: {
  hasProject: boolean;
  attemptedPath?: string | undefined;
  error?: string | undefined;
  opening: boolean;
  onOpenProject(): Promise<void>;
}): React.ReactElement {
  if (!hasProject) {
    return (
      <div className="empty-editor empty-project">
        <ProjectOpenPanel
          attemptedPath={attemptedPath}
          error={error}
          opening={opening}
          onOpenProject={() => { void onOpenProject(); }}
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
