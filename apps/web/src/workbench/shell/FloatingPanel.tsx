import React from 'react';
import { CloseButton, Panel, PanelBody } from '../ui/index.js';
import {
  type FloatingPanelId,
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
  FLOATING_PANEL_DRAG_HIT_AREA_CSS_VALUE
} from './windowBounds';
import { useI18n, type WorkbenchI18n, type WorkbenchTranslationKey } from '../i18n';
import {
  FloatingPanelResizeHandles,
  floatingPanelDragHandleProps
} from './floatingPanelInteractions.js';

const floatingPanelTitleKeys: Record<FloatingPanelId, WorkbenchTranslationKey> = {
  explorer: 'shell.panels.explorer',
  inspector: 'shell.panels.inspector',
  settings: 'shell.panels.settings',
  terminal: 'shell.panels.terminal'
};

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

function floatingPanelTitle(panelId: FloatingPanelId, i18n: WorkbenchI18n): string {
  return i18n.t(floatingPanelTitleKeys[panelId]);
}

export function FloatingPanelContent({
  panelId,
  explorerPanel,
  inspectorPanel,
  settingsPanel,
  terminalPanel
}: {
  panelId: FloatingPanelId;
  explorerPanel: React.ReactElement;
  inspectorPanel: React.ReactElement;
  settingsPanel: React.ReactElement;
  terminalPanel: React.ReactElement;
}): React.ReactElement {
  if (panelId === 'explorer') {
    return explorerPanel;
  }
  if (panelId === 'inspector') {
    return inspectorPanel;
  }
  if (panelId === 'terminal') {
    return terminalPanel;
  }
  return settingsPanel;
}
