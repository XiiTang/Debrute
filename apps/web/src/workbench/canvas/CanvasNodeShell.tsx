import React, { useLayoutEffect, useRef } from 'react';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import type { ResizeHandle } from '../services/canvasInteraction';
import type { CanvasStageRuntime } from './runtime/CanvasStageRuntime';
import { CanvasNodeContent } from './CanvasNodeContent';

const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

export interface CanvasNodeShellProps {
  node: ProjectedCanvasNode;
  selected: boolean;
  hovered: boolean;
  culled: boolean;
  zIndex: number;
  stageRuntime: CanvasStageRuntime;
  actions: WorkbenchActions;
  textBuffer: TextFileBuffer | undefined;
  onPointerDown: (node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => void;
  onPointerMove: (event: React.PointerEvent<Element>) => void;
  onPointerUp: (event: React.PointerEvent<Element>) => void;
  onPointerEnter: (node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => void;
  onPointerLeave: (node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => void;
  onContextMenu: (node: ProjectedCanvasNode, event: React.MouseEvent<Element>) => void;
  onSelectNode: (node: ProjectedCanvasNode) => void;
  onResizePointerDown: (node: ProjectedCanvasNode, handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) => void;
}

function CanvasNodeShellComponent({
  node,
  selected,
  hovered,
  culled,
  zIndex,
  stageRuntime,
  actions,
  textBuffer,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerEnter,
  onPointerLeave,
  onContextMenu,
  onSelectNode,
  onResizePointerDown
}: CanvasNodeShellProps): React.ReactElement {
  const elementRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }
    return stageRuntime.registerNodeShell(node.projectRelativePath, element);
  }, [stageRuntime, node.projectRelativePath]);

  useLayoutEffect(() => {
    stageRuntime.setNodeLayout(node.projectRelativePath, {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      z: zIndex
    });
  }, [stageRuntime, node.height, node.projectRelativePath, node.width, node.x, node.y, zIndex]);

  const className = [
    'canvas-node-element',
    'canvas-node-shell',
    node.mediaKind,
    selected ? 'selected' : '',
    hovered ? 'hovered' : '',
    node.nodeKind,
    usesFixedNodePresentation(node) ? 'fixed-presentation' : ''
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={elementRef}
      data-canvas-entity="node"
      data-canvas-node-path={node.projectRelativePath}
      className={className}
      style={{ left: 0, top: 0 } as React.CSSProperties}
      onPointerDown={node.mediaKind === 'text' ? undefined : (event) => onPointerDown(node, event)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerEnter={(event) => onPointerEnter(node, event)}
      onPointerLeave={(event) => onPointerLeave(node, event)}
      onContextMenu={(event) => onContextMenu(node, event)}
    >
      {usesFixedNodePresentation(node) ? (
        <div className="canvas-node-presentation">
          <CanvasNodeContent
            node={node}
            selected={selected}
            culled={culled}
            actions={actions}
            textBuffer={textBuffer}
            onSelectNode={() => onSelectNode(node)}
            onTitlePointerDown={(event) => onPointerDown(node, event)}
            onTitlePointerMove={onPointerMove}
            onTitlePointerUp={onPointerUp}
          />
        </div>
      ) : (
        <CanvasNodeContent
          node={node}
          selected={selected}
          culled={culled}
          actions={actions}
          textBuffer={textBuffer}
          onSelectNode={() => onSelectNode(node)}
          onTitlePointerDown={(event) => onPointerDown(node, event)}
          onTitlePointerMove={onPointerMove}
          onTitlePointerUp={onPointerUp}
        />
      )}
      {selected ? RESIZE_HANDLES.map((handle) => (
        <button
          key={handle}
          type="button"
          className={`canvas-node-resize ${handle}`}
          aria-label={`Resize node ${handle}`}
          title={`Resize ${handle}`}
          onPointerDown={(event) => onResizePointerDown(node, handle, event)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      )) : null}
    </div>
  );
}

export const CanvasNodeShell = React.memo(CanvasNodeShellComponent, areCanvasNodeShellPropsEqual);

export function areCanvasNodeShellPropsEqual(
  previous: CanvasNodeShellProps,
  next: CanvasNodeShellProps
): boolean {
  return previous.node === next.node
    && previous.selected === next.selected
    && previous.hovered === next.hovered
    && previous.culled === next.culled
    && previous.zIndex === next.zIndex
    && previous.stageRuntime === next.stageRuntime
    && (previous.node.mediaKind === 'text' ? previous.actions === next.actions : true)
    && previous.textBuffer === next.textBuffer
    && previous.onPointerDown === next.onPointerDown
    && previous.onPointerMove === next.onPointerMove
    && previous.onPointerUp === next.onPointerUp
    && previous.onPointerEnter === next.onPointerEnter
    && previous.onPointerLeave === next.onPointerLeave
    && previous.onContextMenu === next.onContextMenu
    && previous.onSelectNode === next.onSelectNode
    && previous.onResizePointerDown === next.onResizePointerDown;
}

function usesFixedNodePresentation(node: ProjectedCanvasNode): boolean {
  return node.nodeKind === 'directory'
    || node.mediaKind === 'text'
    || node.mediaKind === 'audio'
    || node.mediaKind === 'unknown'
    || !node.mediaKind;
}
