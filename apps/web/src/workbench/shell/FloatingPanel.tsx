import React from 'react';
import type { DebruteProductPlatform } from '@debrute/app-protocol';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ProjectTree } from '../project-explorer/ProjectTree';
import { CloseButton, Panel, PanelBody } from '../ui/index.js';
import type { ProjectTreeInlineEditState } from '../project-explorer/projectTreeEditing';
import type { ProjectTreeFileKeyboardCommand } from '../project-explorer/projectTreeKeyboardCommands';
import {
  FLOATING_PANEL_RESIZE_DIRECTIONS,
  type FloatingPanelId,
  type FloatingPanelResizeDirection,
  type FloatingPanelResizeInput,
  type FloatingPanelState
} from './floatingPanels';
import {
  panelWindowIdentity,
  workbenchWindowZIndex,
  type WorkbenchWindowOrderState
} from './workbenchWindowOrder';
import {
  FLOATING_PANEL_DRAG_HIT_AREA_CSS_PROPERTY,
  FLOATING_PANEL_DRAG_HIT_AREA_CSS_VALUE,
  type WorkbenchWindowRect
} from './windowBounds';
import type {
  WorkbenchContextMenuPosition,
  WorkbenchContextMenuTarget,
  WorkbenchFileClipboard
} from './contextMenu';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { Inspector } from './Inspector';
import type { CanvasEditorRuntime } from '../canvas/runtime/CanvasEditorRuntime';
import { useI18n, type WorkbenchI18n, type WorkbenchTranslationKey } from '../i18n';

const floatingPanelTitleKeys: Record<FloatingPanelId, WorkbenchTranslationKey> = {
  explorer: 'shell.panels.explorer',
  inspector: 'shell.panels.inspector',
  settings: 'shell.panels.settings',
  terminal: 'shell.panels.terminal'
};

interface FloatingPanelResizeStart extends WorkbenchWindowRect {
  pointerX: number;
  pointerY: number;
  direction: FloatingPanelResizeDirection;
}

export function WorkbenchFloatingPanelShell({
  panelId,
  state,
  orderState,
  children,
  onClose,
  onBringToFront,
  onDrag,
  onResize
}: {
  panelId: FloatingPanelId;
  state: FloatingPanelState;
  orderState: WorkbenchWindowOrderState;
  children: React.ReactElement;
  onClose: () => void;
  onBringToFront: () => void;
  onDrag: (dx: number, dy: number) => void;
  onResize: (input: FloatingPanelResizeInput) => void;
}): React.ReactElement {
  const i18n = useI18n();
  const title = floatingPanelTitle(panelId, i18n);
  const layout = state.panels[panelId];
  const dragStart = React.useRef<{ x: number; y: number } | undefined>(undefined);
  const dragHandleProps = floatingPanelDragHandleProps({
    dragStart,
    onBringToFront,
    onDrag
  });
  return (
    <Panel
      className={`floating-panel floating-panel-${panelId}`}
      data-testid={`floating-panel-${panelId}`}
      style={{
        [FLOATING_PANEL_DRAG_HIT_AREA_CSS_PROPERTY]: FLOATING_PANEL_DRAG_HIT_AREA_CSS_VALUE,
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
        zIndex: workbenchWindowZIndex(orderState, panelWindowIdentity(panelId))
      } as React.CSSProperties}
      onPointerDown={onBringToFront}
    >
      <div className="floating-panel-interaction-row">
        <div className="floating-panel-drag-hit-area" role="presentation" {...dragHandleProps} />
        <div className="floating-panel-title" aria-hidden="true">{title}</div>
        <CloseButton
          className="floating-panel-close-button"
          label={i18n.t('shell.panels.close', { title })}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        />
      </div>
      <PanelBody className="floating-panel-body">
        {children}
      </PanelBody>
      <FloatingPanelResizeHandles
        layout={layout}
        onBringToFront={onBringToFront}
        onResize={onResize}
      />
    </Panel>
  );
}

export function FloatingPanelResizeHandles({
  layout,
  onBringToFront,
  onResize
}: {
  layout: WorkbenchWindowRect;
  onBringToFront: () => void;
  onResize: (input: FloatingPanelResizeInput) => void;
}): React.ReactElement {
  const resizeStart = React.useRef<FloatingPanelResizeStart | undefined>(undefined);
  return (
    <>
      {FLOATING_PANEL_RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`floating-panel-resize-handle floating-panel-resize-handle--${direction}`}
          role="presentation"
          {...floatingPanelResizeHandleProps({
            direction,
            resizeStart,
            layout,
            onBringToFront,
            onResize
          })}
        />
      ))}
    </>
  );
}

function floatingPanelTitle(panelId: FloatingPanelId, i18n: WorkbenchI18n): string {
  return i18n.t(floatingPanelTitleKeys[panelId]);
}

export function FloatingPanelContent({
  panelId,
  state,
  activeCanvasId,
  activeCanvasRuntime,
  actions,
  onOpenContextMenu,
  fileClipboard,
  inlineProjectTreeEdit,
  onEditValueChange,
  onEditSubmit,
  onEditCancel,
  onClearCut,
  onExplorerSelectionChange,
  onLocateFileInCanvas,
  onProjectTreeInternalDrop,
  onProjectTreeExternalDrop,
  onCreateRootFile,
  productPlatform,
  onKeyboardFileCommand,
  terminalPanel
}: {
  panelId: FloatingPanelId;
  state: WorkbenchState;
  activeCanvasId: string | undefined;
  activeCanvasRuntime: CanvasEditorRuntime | undefined;
  actions: WorkbenchActions;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  fileClipboard?: WorkbenchFileClipboard | undefined;
  inlineProjectTreeEdit?: ProjectTreeInlineEditState | undefined;
  onEditValueChange?: ((value: string) => void) | undefined;
  onEditSubmit?: (() => void) | undefined;
  onEditCancel?: (() => void) | undefined;
  onClearCut?: (() => void) | undefined;
  onExplorerSelectionChange: (selection: WorkbenchState['explorerSelection']) => void;
  onLocateFileInCanvas?: ((projectRelativePath: string) => void) | undefined;
  onProjectTreeInternalDrop?: ((input: {
    entries: Array<{ projectRelativePath: string; kind: 'file' | 'directory' }>;
    targetDirectoryProjectRelativePath: string;
    operation: 'copy' | 'move';
  }) => void) | undefined;
  onProjectTreeExternalDrop?: ((input: {
    dataTransfer: DataTransfer;
    targetDirectoryProjectRelativePath: string;
  }) => void) | undefined;
  onCreateRootFile?: (() => void) | undefined;
  productPlatform: DebruteProductPlatform;
  onKeyboardFileCommand?: ((command: ProjectTreeFileKeyboardCommand, target: WorkbenchContextMenuTarget) => void) | undefined;
  terminalPanel: React.ReactElement;
}): React.ReactElement {
  if (panelId === 'explorer') {
    return (
      <ProjectTree
        snapshot={state.snapshot}
        selection={state.explorerSelection}
        cutPaths={fileClipboard?.operation === 'cut' ? fileClipboard.entries.map((entry) => entry.projectRelativePath) : []}
        editing={inlineProjectTreeEdit}
        onSelectionChange={onExplorerSelectionChange}
        onLocateFileInCanvas={onLocateFileInCanvas}
        onInternalDrop={onProjectTreeInternalDrop}
        onExternalDrop={onProjectTreeExternalDrop}
        onOpenContextMenu={onOpenContextMenu}
        onCreateRootFile={onCreateRootFile}
        onEditValueChange={onEditValueChange}
        onEditSubmit={onEditSubmit}
        onEditCancel={onEditCancel}
        onClearCut={onClearCut}
        productPlatform={productPlatform}
        onKeyboardFileCommand={onKeyboardFileCommand}
      />
    );
  }
  if (panelId === 'inspector') {
    return <Inspector state={state} activeCanvasId={activeCanvasId} selection={activeCanvasRuntime?.getSnapshot().selection} actions={actions} />;
  }
  if (panelId === 'terminal') {
    return terminalPanel;
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

export function floatingPanelResizeHandleProps({
  direction,
  resizeStart,
  layout,
  onBringToFront,
  onResize
}: {
  direction: FloatingPanelResizeDirection;
  resizeStart: React.MutableRefObject<FloatingPanelResizeStart | undefined>;
  layout: WorkbenchWindowRect;
  onBringToFront: () => void;
  onResize: (input: FloatingPanelResizeInput) => void;
}): React.HTMLAttributes<HTMLElement> {
  return {
    onPointerDown: (event) => {
      event.stopPropagation();
      resizeStart.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        direction,
        x: layout.x,
        y: layout.y,
        width: layout.width,
        height: layout.height
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      onBringToFront();
    },
    onPointerMove: (event) => {
      if (!resizeStart.current) {
        return;
      }
      onResize({
        ...resizeFloatingPanelRect(resizeStart.current, event.clientX, event.clientY),
        direction: resizeStart.current.direction
      });
    },
    onPointerUp: (event) => {
      resizeStart.current = undefined;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
}

function resizeFloatingPanelRect(
  start: FloatingPanelResizeStart,
  pointerX: number,
  pointerY: number
): WorkbenchWindowRect {
  const dx = pointerX - start.pointerX;
  const dy = pointerY - start.pointerY;
  return {
    x: start.direction.includes('w') ? start.x + dx : start.x,
    y: start.direction.includes('n') ? start.y + dy : start.y,
    width: start.width
      + (start.direction.includes('e') ? dx : 0)
      - (start.direction.includes('w') ? dx : 0),
    height: start.height
      + (start.direction.includes('s') ? dy : 0)
      - (start.direction.includes('n') ? dy : 0)
  };
}
