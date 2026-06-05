import React from 'react';
import { Map } from 'lucide-react';
import type { CanvasDocument, CanvasProjection } from '@debrute/canvas-core';
import type { CanvasMinimapPanelPlacement } from '../shell/floatingBars';
import { CANVAS_MINIMAP_PANEL_SIZE } from '../shell/floatingBars';
import type { CanvasPoint, CanvasRect } from '../services/canvasInteraction';
import type { CanvasMinimapDragState, CanvasSize } from './canvasMinimap';
import {
  beginCanvasMinimapDrag,
  buildCanvasMinimapModel,
  clientPointToMinimapPoint,
  hasValidMinimapNodes,
  updateCanvasMinimapDrag,
  type CanvasMinimapModel
} from './canvasMinimap';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './runtime/CanvasEditorRuntime';
import { DEFAULT_CANVAS_CAMERA, type CanvasCamera } from './runtime/canvasCamera';

export function CanvasMinimapBar({
  canvas,
  projection,
  runtime,
  open,
  onOpenChange,
  panelPlacement
}: {
  canvas: CanvasDocument | undefined;
  projection: CanvasProjection | undefined;
  runtime: CanvasEditorRuntime | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  panelPlacement: CanvasMinimapPanelPlacement;
}): React.ReactElement {
  const barRef = React.useRef<HTMLButtonElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const runtimeSnapshot = useOptionalRuntimeSnapshot(runtime);
  const [liveCamera, setLiveCamera] = React.useState<CanvasCamera>(runtimeSnapshot?.camera ?? DEFAULT_CANVAS_CAMERA);
  React.useEffect(() => {
    if (runtimeSnapshot) {
      setLiveCamera(runtimeSnapshot.camera);
    }
  }, [runtimeSnapshot]);
  React.useEffect(() => {
    if (!runtime || !open) {
      return;
    }
    setLiveCamera(runtime.getSnapshot().camera);
    return runtime.subscribeCamera((camera) => {
      setLiveCamera((current) => sameCanvasCamera(current, camera) ? current : camera);
    });
  }, [open, runtime]);
  const modelCamera = open ? liveCamera : runtimeSnapshot?.camera ?? DEFAULT_CANVAS_CAMERA;
  const enabled = Boolean(
    canvas
    && projection
    && runtime
    && hasValidMinimapNodes(projection.nodes)
    && runtimeSnapshot?.surfaceSize
  );
  const model = React.useMemo(() => (
    open && enabled && projection && runtimeSnapshot?.surfaceSize
      ? buildCanvasMinimapModel({
          nodes: projection.nodes,
          selection: runtimeSnapshot.selection,
          camera: modelCamera,
          surfaceSize: runtimeSnapshot.surfaceSize,
          minimapSize: CANVAS_MINIMAP_PANEL_SIZE
        })
      : undefined
  ), [enabled, modelCamera, open, projection, runtimeSnapshot?.selection, runtimeSnapshot?.surfaceSize]);

  React.useEffect(() => {
    if (!enabled && open) {
      onOpenChange(false);
    }
  }, [enabled, onOpenChange, open]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const activeElement = document.activeElement;
      if (
        event.key === 'Escape'
        && activeElement instanceof HTMLElement
        && (
          barRef.current?.contains(activeElement)
          || panelRef.current?.contains(activeElement)
        )
      ) {
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onOpenChange, open]);

  return (
    <>
      <button
        type="button"
        ref={barRef}
        className={open ? 'canvas-minimap-bar active' : 'canvas-minimap-bar'}
        data-testid="canvas-minimap-bar"
        data-canvas-local-wheel="true"
        title="Mini Map"
        aria-label="Mini Map"
        aria-pressed={open}
        disabled={!enabled}
        onPointerDown={stopCanvasMinimapEvent}
        onPointerMove={stopCanvasMinimapEvent}
        onPointerUp={stopCanvasMinimapEvent}
        onWheel={stopCanvasMinimapEvent}
        onClick={(event) => {
          stopCanvasMinimapEvent(event);
          if (enabled) {
            onOpenChange(!open);
          }
        }}
        onDoubleClick={stopCanvasMinimapEvent}
        onContextMenu={stopCanvasMinimapEvent}
      >
        <Map size={13} />
      </button>
      {open && enabled && model && runtime ? (
        <CanvasMinimapPanel
          ref={panelRef}
          model={model}
          runtime={runtime}
          panelPlacement={panelPlacement}
        />
      ) : null}
    </>
  );
}

const CanvasMinimapPanel = React.forwardRef<HTMLDivElement, {
  model: CanvasMinimapModel;
  runtime: CanvasEditorRuntime;
  panelPlacement: CanvasMinimapPanelPlacement;
}>(function CanvasMinimapPanel({
  model,
  runtime,
  panelPlacement
}, ref): React.ReactElement {
  const dragStateRef = React.useRef<CanvasMinimapDragState | undefined>(undefined);

  const beginDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    const dragState = requestCanvasMinimapPointerDownCameraChange({
      button: event.button,
      pointerId: event.pointerId,
      clientPoint: { x: event.clientX, y: event.clientY },
      minimapRect: minimapEventRect(event),
      model,
      runtime
    });
    if (!dragState) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = dragState;
  };

  const updateDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState) {
      return;
    }
    requestCanvasMinimapPointerMoveCameraChange({
      pointerId: event.pointerId,
      dragState,
      clientPoint: { x: event.clientX, y: event.clientY },
      minimapRect: minimapEventRect(event),
      runtime
    });
  };

  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    dragStateRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={ref}
      className="canvas-minimap-panel"
      data-testid="canvas-minimap-panel"
      data-canvas-local-wheel="true"
      style={{
        left: panelPlacement.x,
        top: panelPlacement.y,
        width: panelPlacement.width,
        height: panelPlacement.height
      }}
      onPointerDown={stopCanvasMinimapEvent}
      onPointerMove={stopCanvasMinimapEvent}
      onPointerUp={stopCanvasMinimapEvent}
      onWheel={stopCanvasMinimapEvent}
      onClick={stopCanvasMinimapEvent}
      onDoubleClick={stopCanvasMinimapEvent}
      onContextMenu={stopCanvasMinimapEvent}
    >
      <svg
        className="canvas-minimap-svg"
        role="img"
        aria-label="Canvas overview"
        viewBox={`0 0 ${CANVAS_MINIMAP_PANEL_SIZE.width} ${CANVAS_MINIMAP_PANEL_SIZE.height}`}
        onPointerDown={beginDrag}
        onPointerMove={updateDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {model.nodeRects.map((node) => (
          <rect
            key={node.projectRelativePath}
            data-minimap-node-path={node.projectRelativePath}
            className={node.selected ? 'canvas-minimap-node selected' : 'canvas-minimap-node'}
            x={node.rect.x}
            y={node.rect.y}
            width={Math.max(1, node.rect.width)}
            height={Math.max(1, node.rect.height)}
            rx="1.5"
          />
        ))}
        <rect
          className="canvas-minimap-viewport"
          x={model.viewportRect.x}
          y={model.viewportRect.y}
          width={Math.max(2, model.viewportRect.width)}
          height={Math.max(2, model.viewportRect.height)}
          rx="3"
        />
      </svg>
    </div>
  );
});

function requestCanvasMinimapPointerDownCameraChange(input: {
  button: number;
  pointerId: number;
  clientPoint: CanvasPoint;
  minimapRect: CanvasRect;
  model: CanvasMinimapModel;
  runtime: CanvasEditorRuntime;
  minimapSize?: CanvasSize;
}): CanvasMinimapDragState | undefined {
  if (input.button !== 0) {
    return undefined;
  }
  const runtimeSnapshot = input.runtime.getSnapshot();
  if (!runtimeSnapshot.surfaceSize) {
    return undefined;
  }
  const next = beginCanvasMinimapDrag({
    pointerId: input.pointerId,
    minimapPoint: clientPointToMinimapPoint({
      clientPoint: input.clientPoint,
      minimapRect: input.minimapRect,
      minimapSize: input.minimapSize ?? CANVAS_MINIMAP_PANEL_SIZE
    }),
    model: input.model,
    camera: runtimeSnapshot.camera,
    surfaceSize: runtimeSnapshot.surfaceSize
  });
  input.runtime.camera.setCamera(next.camera);
  return next.dragState;
}

function requestCanvasMinimapPointerMoveCameraChange(input: {
  pointerId: number;
  dragState: CanvasMinimapDragState;
  clientPoint: CanvasPoint;
  minimapRect: CanvasRect;
  runtime: CanvasEditorRuntime;
  minimapSize?: CanvasSize;
}): boolean {
  if (input.dragState.pointerId !== input.pointerId) {
    return false;
  }
  const runtimeSnapshot = input.runtime.getSnapshot();
  if (!runtimeSnapshot.surfaceSize) {
    return false;
  }
  input.runtime.camera.setCamera(updateCanvasMinimapDrag({
    dragState: input.dragState,
    minimapPoint: clientPointToMinimapPoint({
      clientPoint: input.clientPoint,
      minimapRect: input.minimapRect,
      minimapSize: input.minimapSize ?? CANVAS_MINIMAP_PANEL_SIZE
    }),
    camera: runtimeSnapshot.camera,
    surfaceSize: runtimeSnapshot.surfaceSize
  }));
  return true;
}

function useOptionalRuntimeSnapshot(runtime: CanvasEditorRuntime | undefined): CanvasRuntimeSnapshot | undefined {
  return React.useSyncExternalStore(
    runtime ? runtime.subscribe : emptySubscribe,
    runtime ? runtime.getSnapshot : undefinedRuntimeSnapshot,
    runtime ? runtime.getSnapshot : undefinedRuntimeSnapshot
  );
}

function emptySubscribe(): () => void {
  return () => undefined;
}

function undefinedRuntimeSnapshot(): undefined {
  return undefined;
}

function sameCanvasCamera(left: CanvasCamera, right: CanvasCamera): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function stopCanvasMinimapEvent(event: Pick<React.SyntheticEvent, 'stopPropagation'>): void {
  event.stopPropagation();
}

function minimapEventRect(event: React.PointerEvent<SVGSVGElement>): CanvasRect {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  };
}
