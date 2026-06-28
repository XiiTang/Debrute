import React from 'react';
import { Map } from 'lucide-react';
import type { CanvasDocument, CanvasProjection } from '@debrute/canvas-core';
import type { CanvasMinimapPanelPlacement } from '../shell/floatingBars';
import { CANVAS_MINIMAP_PANEL_SIZE } from '../shell/floatingBars';
import type { CanvasPoint, CanvasRect } from '../services/canvasInteraction';
import type { CanvasMinimapDragState, CanvasSize } from './canvasMinimap';
import {
  beginCanvasMinimapDrag,
  buildCanvasMinimapStaticModel,
  buildCanvasMinimapViewportModel,
  clientPointToMinimapPoint,
  hasValidMinimapNodes,
  updateCanvasMinimapDrag,
  type CanvasMinimapStaticModel,
  type CanvasMinimapModel
} from './canvasMinimap';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './runtime/CanvasEditorRuntime';
import { DEFAULT_CANVAS_CAMERA } from './runtime/canvasCamera';
import type { CanvasOverlayRuntime } from './CanvasOverlayRuntime';
import { IconButton } from '../ui';
import { useI18n } from '../i18n';

export function CanvasMinimapBar({
  canvas,
  nodes,
  runtime,
  overlayRuntime,
  open,
  onOpenChange,
  panelPlacement
}: {
  canvas: CanvasDocument | undefined;
  nodes: CanvasProjection['nodes'] | undefined;
  runtime: CanvasEditorRuntime | undefined;
  overlayRuntime: CanvasOverlayRuntime;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  panelPlacement: CanvasMinimapPanelPlacement;
}): React.ReactElement {
  const i18n = useI18n();
  const barRef = React.useRef<HTMLButtonElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const runtimeSnapshot = useOptionalRuntimeSnapshot(runtime);
  const modelCamera = runtimeSnapshot?.camera ?? DEFAULT_CANVAS_CAMERA;
  const enabled = Boolean(
    canvas
    && nodes
    && runtime
    && hasValidMinimapNodes(nodes)
    && runtimeSnapshot?.surfaceSize
  );
  const staticModel = React.useMemo(() => (
    open && enabled && nodes && runtimeSnapshot?.surfaceSize
      ? buildCanvasMinimapStaticModel({
          nodes,
          selection: runtimeSnapshot.selection,
          camera: modelCamera,
          surfaceSize: runtimeSnapshot.surfaceSize,
          minimapSize: CANVAS_MINIMAP_PANEL_SIZE
        })
      : undefined
  ), [enabled, modelCamera, nodes, open, runtimeSnapshot?.selection, runtimeSnapshot?.surfaceSize]);
  const initialViewport = React.useMemo(() => (
    open && runtimeSnapshot?.surfaceSize && staticModel
      ? buildCanvasMinimapViewportModel({
          transform: staticModel.transform,
          camera: modelCamera,
          surfaceSize: runtimeSnapshot.surfaceSize
        })
      : undefined
  ), [modelCamera, open, runtimeSnapshot?.surfaceSize, staticModel]);

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
      <IconButton
        ref={barRef}
        className="db-floating-bar canvas-minimap-bar db-canvas-control"
        data-testid="canvas-minimap-bar"
        data-canvas-local-wheel="true"
        label={i18n.t('canvas.minimap.title')}
        pressed={open}
        icon={<Map size={13} />}
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
      />
      {open && enabled && staticModel && initialViewport && runtime ? (
        <CanvasMinimapPanel
          ref={panelRef}
          staticModel={staticModel}
          initialViewportRect={initialViewport.viewportRect}
          runtime={runtime}
          overlayRuntime={overlayRuntime}
          panelPlacement={panelPlacement}
          overviewLabel={i18n.t('canvas.minimap.overview')}
        />
      ) : null}
    </>
  );
}

const CanvasMinimapPanel = React.forwardRef<HTMLDivElement, {
  staticModel: CanvasMinimapStaticModel;
  initialViewportRect: CanvasRect;
  runtime: CanvasEditorRuntime;
  overlayRuntime: CanvasOverlayRuntime;
  panelPlacement: CanvasMinimapPanelPlacement;
  overviewLabel: string;
}>(function CanvasMinimapPanel({
  staticModel,
  initialViewportRect,
  runtime,
  overlayRuntime,
  panelPlacement,
  overviewLabel
}, ref): React.ReactElement {
  const dragStateRef = React.useRef<CanvasMinimapDragState | undefined>(undefined);
  const viewportRef = React.useRef<SVGRectElement | null>(null);

  React.useLayoutEffect(() => {
    if (!viewportRef.current) {
      return;
    }
    return overlayRuntime.bindMinimapViewport(viewportRef.current);
  }, [overlayRuntime]);

  React.useEffect(() => {
    const sync = () => {
      const snapshot = runtime.getSnapshot();
      const viewport = buildCanvasMinimapViewportModel({
        transform: staticModel.transform,
        camera: snapshot.camera,
        surfaceSize: snapshot.surfaceSize
      });
      if (viewport) {
        overlayRuntime.setMinimapViewport(viewport.viewportRect);
      }
    };
    sync();
    return runtime.subscribeCamera(sync);
  }, [overlayRuntime, runtime, staticModel]);

  const beginDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    const dragState = requestCanvasMinimapPointerDownCameraChange({
      button: event.button,
      pointerId: event.pointerId,
      clientPoint: { x: event.clientX, y: event.clientY },
      minimapRect: minimapEventRect(event),
      staticModel,
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
      className="db-floating-bar canvas-minimap-panel"
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
        aria-label={overviewLabel}
        viewBox={`0 0 ${CANVAS_MINIMAP_PANEL_SIZE.width} ${CANVAS_MINIMAP_PANEL_SIZE.height}`}
        onPointerDown={beginDrag}
        onPointerMove={updateDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {staticModel.nodeRects.map((node) => (
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
          ref={viewportRef}
          className="canvas-minimap-viewport"
          x={initialViewportRect.x}
          y={initialViewportRect.y}
          width={Math.max(2, initialViewportRect.width)}
          height={Math.max(2, initialViewportRect.height)}
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
  staticModel: CanvasMinimapStaticModel;
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
  const viewport = buildCanvasMinimapViewportModel({
    transform: input.staticModel.transform,
    camera: runtimeSnapshot.camera,
    surfaceSize: runtimeSnapshot.surfaceSize
  });
  if (!viewport) {
    return undefined;
  }
  const model: CanvasMinimapModel = {
    ...input.staticModel,
    ...viewport
  };
  const next = beginCanvasMinimapDrag({
    pointerId: input.pointerId,
    minimapPoint: clientPointToMinimapPoint({
      clientPoint: input.clientPoint,
      minimapRect: input.minimapRect,
      minimapSize: input.minimapSize ?? CANVAS_MINIMAP_PANEL_SIZE
    }),
    model,
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
