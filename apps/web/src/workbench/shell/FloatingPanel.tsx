import React from 'react';
import { CloseButton, Panel, PanelBody } from '../ui/index.js';
import {
  type FloatingPanelId,
  type FloatingPanelLayout
} from './floatingPanels';
import {
  FLOATING_PANEL_DRAG_HIT_AREA_CSS_PROPERTY,
  FLOATING_PANEL_DRAG_HIT_AREA_CSS_VALUE
} from './windowBounds';
import type { WorkbenchWindowRect } from './windowBounds.js';
import { useI18n, type WorkbenchI18n, type WorkbenchTranslationKey } from '../i18n';
import {
  FloatingWindowResizeHandles,
  floatingWindowRectStyle,
  useFloatingWindowGesture,
  type FloatingWindowGesture
} from './floatingWindowGesture.js';

const floatingPanelTitleKeys: Record<FloatingPanelId, WorkbenchTranslationKey> = {
  explorer: 'shell.panels.explorer',
  inspector: 'shell.panels.inspector',
  feedback: 'shell.panels.feedback',
  settings: 'shell.panels.settings',
  terminal: 'shell.panels.terminal'
};

export function WorkbenchFloatingPanelShell({
  panelId,
  layout,
  zIndex,
  children,
  onClose,
  onFocus,
  resolveRect,
  onCommitRect
}: {
  panelId: FloatingPanelId;
  layout: FloatingPanelLayout;
  zIndex: number;
  children: React.ReactElement;
  onClose: () => void;
  onFocus: () => void;
  resolveRect(candidate: WorkbenchWindowRect, gesture: FloatingWindowGesture): WorkbenchWindowRect;
  onCommitRect(rect: WorkbenchWindowRect): void;
}): React.ReactElement {
  const i18n = useI18n();
  const title = floatingPanelTitle(panelId, i18n);
  const windowRef = React.useRef<HTMLElement>(null);
  const gesture = useFloatingWindowGesture({
    windowRef,
    rect: layout,
    onFocus,
    resolveRect,
    onCommit: onCommitRect
  });
  return (
    <Panel
      ref={windowRef}
      className={`floating-panel floating-panel-${panelId}`}
      data-testid={`floating-panel-${panelId}`}
      style={{
        ...floatingWindowRectStyle(layout),
        [FLOATING_PANEL_DRAG_HIT_AREA_CSS_PROPERTY]: FLOATING_PANEL_DRAG_HIT_AREA_CSS_VALUE,
        zIndex
      } as React.CSSProperties}
      onPointerDown={onFocus}
    >
      <div className="floating-panel-interaction-row">
        <div className="floating-panel-drag-hit-area" role="presentation" {...gesture.dragHandleProps} />
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
      <FloatingWindowResizeHandles resizeHandleProps={gesture.resizeHandleProps} />
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
  feedbackPanel,
  settingsPanel,
  terminalPanel
}: {
  panelId: FloatingPanelId;
  explorerPanel: React.ReactElement;
  inspectorPanel: React.ReactElement;
  feedbackPanel: React.ReactElement;
  settingsPanel: React.ReactElement;
  terminalPanel: React.ReactElement;
}): React.ReactElement {
  if (panelId === 'explorer') {
    return explorerPanel;
  }
  if (panelId === 'inspector') {
    return inspectorPanel;
  }
  if (panelId === 'feedback') {
    return feedbackPanel;
  }
  if (panelId === 'terminal') {
    return terminalPanel;
  }
  return settingsPanel;
}
