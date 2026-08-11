import React from 'react';
import { Eye, EyeOff, IconButton } from '../ui/index';
import { useI18n } from '../i18n/index';

export interface CanvasHierarchyEdgeVisibilityButtonProps {
  hierarchyEdgesVisible: boolean;
  onHierarchyEdgesVisibleChange(visible: boolean): void;
}

export function CanvasHierarchyEdgeVisibilityButton({
  hierarchyEdgesVisible,
  onHierarchyEdgesVisibleChange
}: CanvasHierarchyEdgeVisibilityButtonProps): React.ReactElement {
  const i18n = useI18n();
  const label = hierarchyEdgesVisible
    ? i18n.t('canvas.hideHierarchyEdges')
    : i18n.t('canvas.showHierarchyEdges');
  return (
    <IconButton
      className="canvas-hierarchy-edge-visibility-button db-canvas-control"
      data-testid="canvas-hierarchy-edge-visibility-button"
      data-canvas-local-wheel="true"
      label={label}
      icon={hierarchyEdgesVisible ? <Eye /> : <EyeOff />}
      pressed={hierarchyEdgesVisible}
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
