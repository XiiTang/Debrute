import React, { useEffect } from 'react';
import {
  AlertTriangle,
  FileText,
  RefreshCw,
  Save,
  X
} from 'lucide-react';
import { CanvasTextEditor } from './CanvasTextEditor';
import type { FloatingTextEditorWindowState, TextFileBuffer, WorkbenchActions } from '../../types';
import {
  textEditorWindowIdentity,
  workbenchWindowZIndex,
  type WorkbenchWindowOrderState
} from '../shell/workbenchWindowOrder';
import { FloatingPanelResizeHandles, floatingPanelDragHandleProps } from '../shell/FloatingPanel';
import type { FloatingPanelResizeInput } from '../shell/floatingPanels';
import { basenameFromProjectPath, textBufferStatus } from '../services/textEditorWindows';
import { DiscardChangesIcon, IconButton, Panel, PanelBody, PanelHeader, PanelTitle, StatusPill } from '../ui';
import {
  FLOATING_TEXT_EDITOR_TITLEBAR_CSS_PROPERTY,
  FLOATING_TEXT_EDITOR_TITLEBAR_CSS_VALUE
} from '../shell/windowBounds';
import { useI18n } from '../i18n';

export function FloatingTextEditorWindow({
  windowState,
  orderState,
  buffer,
  actions,
  onBringToFront,
  onClose,
  onDrag,
  onResize
}: {
  windowState: FloatingTextEditorWindowState;
  orderState: WorkbenchWindowOrderState;
  buffer: TextFileBuffer | undefined;
  actions: WorkbenchActions;
  onBringToFront: () => void;
  onClose: () => void;
  onDrag: (dx: number, dy: number) => void;
  onResize: (input: FloatingPanelResizeInput) => void;
}): React.ReactElement {
  const i18n = useI18n();
  const dragStart = React.useRef<{ x: number; y: number } | undefined>(undefined);
  const dragHandleProps = floatingPanelDragHandleProps({
    dragStart,
    onBringToFront,
    onDrag
  });
  const status = textBufferStatus(buffer, {
    loading: i18n.t('canvas.node.loading'),
    error: i18n.t('canvas.node.error'),
    externalChange: i18n.t('canvas.node.externalChange'),
    saving: i18n.t('canvas.node.saving')
  });

  useEffect(() => {
    void actions.ensureTextFileBuffer(windowState.projectRelativePath);
  }, [actions, windowState.projectRelativePath]);

  return (
    <Panel
      className="floating-panel floating-text-editor-window"
      data-testid="floating-text-editor-window"
      data-canvas-local-wheel="true"
      style={{
        [FLOATING_TEXT_EDITOR_TITLEBAR_CSS_PROPERTY]: FLOATING_TEXT_EDITOR_TITLEBAR_CSS_VALUE,
        left: windowState.x,
        top: windowState.y,
        width: windowState.width,
        height: windowState.height,
        zIndex: workbenchWindowZIndex(orderState, textEditorWindowIdentity(windowState.projectRelativePath))
      } as React.CSSProperties}
      onPointerDown={onBringToFront}
    >
      <PanelHeader className="floating-text-editor-header" {...dragHandleProps}>
        <FileText size={15} />
        <PanelTitle>{basenameFromProjectPath(windowState.projectRelativePath)}</PanelTitle>
        <small>{windowState.projectRelativePath}</small>
        {status ? <StatusPill tone={status.tone}>{status.label}</StatusPill> : null}
        <IconButton
          label={i18n.t('canvas.node.saveFile', { path: windowState.projectRelativePath })}
          disabled={!buffer || !buffer.dirty || buffer.saving}
          icon={<Save size={14} />}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void actions.saveTextFileBuffer(windowState.projectRelativePath)}
        />
        <IconButton
          label={i18n.t('canvas.node.discardFileChanges', { path: windowState.projectRelativePath })}
          title={i18n.t('canvas.node.discardChanges')}
          variant="danger"
          disabled={!buffer || !buffer.dirty || buffer.saving}
          icon={<DiscardChangesIcon size={14} />}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void actions.discardTextFileBuffer(windowState.projectRelativePath)}
        />
        {buffer?.externalChange && !buffer.dirty ? (
          <IconButton
            label={i18n.t('canvas.node.reloadFile', { path: windowState.projectRelativePath })}
            icon={<RefreshCw size={14} />}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void actions.reloadTextFileBuffer(windowState.projectRelativePath)}
          />
        ) : null}
        <IconButton
          label={i18n.t('canvas.node.closeFile', { path: windowState.projectRelativePath })}
          icon={<X size={14} />}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        />
      </PanelHeader>
      <PanelBody className="floating-panel-body floating-text-editor-body">
        {buffer?.error ? (
          <div className="canvas-text-message" data-canvas-text-editor="true">
            <AlertTriangle size={18} />
            <strong>{i18n.t('canvas.node.textError')}</strong>
            <span>{buffer.error}</span>
          </div>
        ) : buffer ? (
          <CanvasTextEditor
            value={buffer.content}
            language={buffer.language}
            wordWrap={buffer.wordWrap}
            onChange={(content) => actions.updateTextFileBuffer(windowState.projectRelativePath, content)}
            onSave={() => void actions.saveTextFileBuffer(windowState.projectRelativePath)}
            onToggleWordWrap={() => actions.toggleTextFileWordWrap(windowState.projectRelativePath)}
          />
        ) : (
          <div className="canvas-text-message" data-canvas-text-editor="true">
            <FileText size={18} />
            <span>{i18n.t('canvas.node.loadingText')}</span>
          </div>
        )}
      </PanelBody>
      <FloatingPanelResizeHandles
        layout={windowState}
        onBringToFront={onBringToFront}
        onResize={onResize}
      />
    </Panel>
  );
}
