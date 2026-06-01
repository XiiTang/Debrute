import React from 'react';
import { X } from 'lucide-react';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ProjectTree } from '../project-explorer/ProjectTree';
import type { ProjectTreeInlineEditState } from '../project-explorer/projectTreeEditing';
import {
  FLOATING_PANEL_DEFINITIONS,
  type FloatingPanelId,
  type FloatingPanelState
} from './floatingPanels';
import {
  panelWindowIdentity,
  workbenchWindowZIndex,
  type WorkbenchWindowOrderState
} from './workbenchWindowOrder';
import type {
  WorkbenchContextMenuPosition,
  WorkbenchContextMenuTarget,
  WorkbenchFileClipboard
} from './contextMenu';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { DiagnosticList, Inspector } from './Inspector';

export function FloatingPanel({
  panelId,
  state,
  orderState,
  children,
  onClose,
  onBringToFront,
  onDrag
}: {
  panelId: FloatingPanelId;
  state: FloatingPanelState;
  orderState: WorkbenchWindowOrderState;
  children: React.ReactElement;
  onClose: () => void;
  onBringToFront: () => void;
  onDrag: (dx: number, dy: number) => void;
}): React.ReactElement {
  const definition = FLOATING_PANEL_DEFINITIONS[panelId];
  const layout = state.panels[panelId];
  const dragStart = React.useRef<{ x: number; y: number } | undefined>(undefined);
  const dragHandleProps = floatingPanelDragHandleProps({
    dragStart,
    onBringToFront,
    onDrag
  });
  return (
    <section
      className={`floating-panel floating-panel-${panelId}`}
      data-testid={`floating-panel-${panelId}`}
      style={{
        left: layout.x,
        top: layout.y,
        width: definition.width,
        height: definition.height,
        zIndex: workbenchWindowZIndex(orderState, panelWindowIdentity(panelId))
      }}
      onPointerDown={onBringToFront}
    >
      <header
        className="floating-panel-header"
        {...dragHandleProps}
      >
        <strong>{definition.title}</strong>
        <button
          type="button"
          aria-label={`Close ${definition.title}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      <div className="floating-panel-body">
        {children}
      </div>
    </section>
  );
}

export function FloatingPanelContent({
  panelId,
  state,
  activeCanvasId,
  actions,
  onOpenContextMenu,
  fileClipboard,
  inlineProjectTreeEdit,
  onEditValueChange,
  onEditSubmit,
  onEditCancel,
  onClearCut
}: {
  panelId: FloatingPanelId;
  state: WorkbenchState;
  activeCanvasId: string | undefined;
  actions: WorkbenchActions;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  fileClipboard?: WorkbenchFileClipboard | undefined;
  inlineProjectTreeEdit?: ProjectTreeInlineEditState | undefined;
  onEditValueChange?: ((value: string) => void) | undefined;
  onEditSubmit?: (() => void) | undefined;
  onEditCancel?: (() => void) | undefined;
  onClearCut?: (() => void) | undefined;
}): React.ReactElement {
  if (panelId === 'explorer') {
    return (
      <ProjectTree
        snapshot={state.snapshot}
        selectedPath={state.explorerSelection}
        cutPath={fileClipboard?.operation === 'cut' ? fileClipboard.projectRelativePath : undefined}
        editing={inlineProjectTreeEdit}
        actions={actions}
        onOpenContextMenu={onOpenContextMenu}
        onEditValueChange={onEditValueChange}
        onEditSubmit={onEditSubmit}
        onEditCancel={onEditCancel}
        onClearCut={onClearCut}
      />
    );
  }
  if (panelId === 'inspector') {
    return <Inspector state={state} activeCanvasId={activeCanvasId} actions={actions} />;
  }
  if (panelId === 'problems') {
    return <DiagnosticList diagnostics={state.snapshot?.diagnostics ?? []} onSelect={(diagnostic) => actions.selectCanvasEntity({ kind: 'diagnostic', id: diagnostic.id })} />;
  }
  return <SettingsPanel state={state} actions={actions} />;
}

export function floatingPanelDragHandleProps({
  dragStart,
  onBringToFront,
  onDrag
}: {
  dragStart: React.MutableRefObject<{ x: number; y: number } | undefined>;
  onBringToFront: () => void;
  onDrag: (dx: number, dy: number) => void;
}): React.HTMLAttributes<HTMLElement> {
  return {
    onPointerDown: (event) => {
      dragStart.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      onBringToFront();
    },
    onPointerMove: (event) => {
      if (!dragStart.current) {
        return;
      }
      const next = { x: event.clientX, y: event.clientY };
      onDrag(next.x - dragStart.current.x, next.y - dragStart.current.y);
      dragStart.current = next;
    },
    onPointerUp: (event) => {
      dragStart.current = undefined;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
}
