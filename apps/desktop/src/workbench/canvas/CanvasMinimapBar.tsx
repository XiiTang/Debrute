import React from 'react';
import { Map } from 'lucide-react';
import type { CanvasDocument, CanvasProjection, CanvasSelection } from '@axis/canvas-core';
import type { CanvasMinimapPanelPlacement } from '../shell/floatingBars';
import { CANVAS_MINIMAP_PANEL_SIZE } from '../shell/floatingBars';
import type { CanvasPoint, CanvasRect } from '../services/canvasInteraction';
import type { CanvasMinimapDragState, CanvasNavigationState, CanvasSize } from './canvasMinimap';
import {
  beginCanvasMinimapDrag,
  buildCanvasMinimapModel,
  clientPointToMinimapPoint,
  hasValidMinimapNodes,
  updateCanvasMinimapDrag,
  type CanvasMinimapModel
} from './canvasMinimap';

export function CanvasMinimapBar({
  canvas,
  projection,
  selection,
  navigationState,
  open,
  onOpenChange,
  panelPlacement
}: {
  canvas: CanvasDocument | undefined;
  projection: CanvasProjection | undefined;
  selection: CanvasSelection | undefined;
  navigationState: CanvasNavigationState | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  panelPlacement: CanvasMinimapPanelPlacement;
}): React.ReactElement {
  const barRef = React.useRef<HTMLButtonElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const enabled = Boolean(
    canvas
    && projection
    && navigationState
    && navigationState.canvasId === canvas.id
    && hasValidMinimapNodes(projection.nodes)
    && validNavigationState(navigationState)
  );
  const model = React.useMemo(() => (
    open && enabled && projection && navigationState
      ? buildCanvasMinimapModel({
          nodes: projection.nodes,
          selection,
          viewport: navigationState.viewport,
          surfaceSize: navigationState.surfaceSize,
          minimapSize: CANVAS_MINIMAP_PANEL_SIZE
        })
      : undefined
  ), [enabled, navigationState, open, projection, selection]);

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
      {open && enabled && model && navigationState ? (
        <CanvasMinimapPanel
          ref={panelRef}
          model={model}
          navigationState={navigationState}
          panelPlacement={panelPlacement}
        />
      ) : null}
    </>
  );
}

const CanvasMinimapPanel = React.forwardRef<HTMLDivElement, {
  model: CanvasMinimapModel;
  navigationState: CanvasNavigationState;
  panelPlacement: CanvasMinimapPanelPlacement;
}>(function CanvasMinimapPanel({
  model,
  navigationState,
  panelPlacement
}, ref): React.ReactElement {
  const dragStateRef = React.useRef<CanvasMinimapDragState | undefined>(undefined);

  const beginDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    const dragState = requestCanvasMinimapPointerDownViewportChange({
      button: event.button,
      pointerId: event.pointerId,
      clientPoint: { x: event.clientX, y: event.clientY },
      minimapRect: minimapEventRect(event),
      model,
      navigationState
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
    requestCanvasMinimapPointerMoveViewportChange({
      pointerId: event.pointerId,
      dragState,
      clientPoint: { x: event.clientX, y: event.clientY },
      minimapRect: minimapEventRect(event),
      navigationState
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

function validNavigationState(state: CanvasNavigationState): boolean {
  return Number.isFinite(state.surfaceSize.width)
    && Number.isFinite(state.surfaceSize.height)
    && state.surfaceSize.width > 0
    && state.surfaceSize.height > 0
    && Number.isFinite(state.viewport.x)
    && Number.isFinite(state.viewport.y)
    && Number.isFinite(state.viewport.zoom)
    && state.viewport.zoom > 0;
}

function requestCanvasMinimapPointerDownViewportChange(input: {
  button: number;
  pointerId: number;
  clientPoint: CanvasPoint;
  minimapRect: CanvasRect;
  model: CanvasMinimapModel;
  navigationState: CanvasNavigationState;
  minimapSize?: CanvasSize;
}): CanvasMinimapDragState | undefined {
  if (input.button !== 0) {
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
    viewport: input.navigationState.viewport,
    surfaceSize: input.navigationState.surfaceSize
  });
  input.navigationState.requestViewportChange(next.viewport);
  return next.dragState;
}

function requestCanvasMinimapPointerMoveViewportChange(input: {
  pointerId: number;
  dragState: CanvasMinimapDragState;
  clientPoint: CanvasPoint;
  minimapRect: CanvasRect;
  navigationState: CanvasNavigationState;
  minimapSize?: CanvasSize;
}): boolean {
  if (input.dragState.pointerId !== input.pointerId) {
    return false;
  }
  input.navigationState.requestViewportChange(updateCanvasMinimapDrag({
    dragState: input.dragState,
    minimapPoint: clientPointToMinimapPoint({
      clientPoint: input.clientPoint,
      minimapRect: input.minimapRect,
      minimapSize: input.minimapSize ?? CANVAS_MINIMAP_PANEL_SIZE
    }),
    viewport: input.navigationState.viewport,
    surfaceSize: input.navigationState.surfaceSize
  }));
  return true;
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
