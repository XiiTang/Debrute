import React from 'react';
import { EyeOff, IconButton } from '../ui/index.js';
import { useI18n } from '../i18n/index.js';

export interface CanvasHierarchyEdgeVisibilityButtonProps {
  hierarchyEdgesVisible: boolean;
  onHierarchyEdgesVisibleChange(visible: boolean): void;
}

export function CanvasHierarchyEdgeVisibilityButton({
  hierarchyEdgesVisible,
  onHierarchyEdgesVisibleChange
}: CanvasHierarchyEdgeVisibilityButtonProps): React.ReactElement {
  const i18n = useI18n();
  return (
    <IconButton
      className="canvas-hierarchy-edge-visibility-button db-canvas-control"
      data-testid="canvas-hierarchy-edge-visibility-button"
      data-canvas-local-wheel="true"
      label={i18n.t('canvas.hideHierarchyEdges')}
      icon={<EyeOff />}
      pressed={!hierarchyEdgesVisible}
      onPointerDown={stopCanvasHierarchyEdgeVisibilityEvent}
      onPointerMove={stopCanvasHierarchyEdgeVisibilityEvent}
      onPointerUp={stopCanvasHierarchyEdgeVisibilityEvent}
      onWheel={stopCanvasHierarchyEdgeVisibilityEvent}
      onClick={(event) => {
        stopCanvasHierarchyEdgeVisibilityEvent(event);
        onHierarchyEdgesVisibleChange(!hierarchyEdgesVisible);
      }}
      onDoubleClick={stopCanvasHierarchyEdgeVisibilityEvent}
      onContextMenu={stopCanvasHierarchyEdgeVisibilityEvent}
    />
  );
}

function stopCanvasHierarchyEdgeVisibilityEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}
