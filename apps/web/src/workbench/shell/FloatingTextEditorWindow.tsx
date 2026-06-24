import React, { useEffect } from 'react';
import {
  AlertTriangle,
  FileText,
  RefreshCw,
  Save,
  X
} from 'lucide-react';
import { CanvasTextEditor } from '../canvas/CanvasTextEditor';
import type { FloatingTextEditorWindowState, TextFileBuffer, WorkbenchActions } from '../../types';
import {
  textEditorWindowIdentity,
  workbenchWindowZIndex,
  type WorkbenchWindowOrderState
} from './workbenchWindowOrder';
import { floatingPanelDragHandleProps } from './FloatingPanel';
import { basenameFromProjectPath, textBufferStatus } from '../services/textEditorWindows';
import { IconButton, Panel, PanelBody, PanelHeader, PanelTitle, StatusPill } from '../ui';

export function FloatingTextEditorWindow({
  windowState,
  orderState,
  buffer,
  actions,
  onBringToFront,
  onClose,
  onDrag
}: {
  windowState: FloatingTextEditorWindowState;
  orderState: WorkbenchWindowOrderState;
  buffer: TextFileBuffer | undefined;
  actions: WorkbenchActions;
  onBringToFront: () => void;
  onClose: () => void;
  onDrag: (dx: number, dy: number) => void;
}): React.ReactElement {
  const dragStart = React.useRef<{ x: number; y: number } | undefined>(undefined);
  const dragHandleProps = floatingPanelDragHandleProps({
    dragStart,
    onBringToFront,
    onDrag
  });
  const status = textBufferStatus(buffer);

  useEffect(() => {
    void actions.ensureTextFileBuffer(windowState.projectRelativePath);
  }, [actions, windowState.projectRelativePath]);

  return (
    <Panel
      className="floating-panel floating-text-editor-window"
      data-testid="floating-text-editor-window"
      style={{
        left: windowState.x,
        top: windowState.y,
        width: windowState.width,
        height: windowState.height,
        zIndex: workbenchWindowZIndex(orderState, textEditorWindowIdentity(windowState.projectRelativePath))
      }}
      onPointerDown={onBringToFront}
    >
      <PanelHeader className="floating-panel-header floating-text-editor-header" {...dragHandleProps}>
        <FileText size={15} />
        <PanelTitle>{basenameFromProjectPath(windowState.projectRelativePath)}</PanelTitle>
        <small>{windowState.projectRelativePath}</small>
        {status ? <StatusPill tone={status.tone}>{status.label}</StatusPill> : null}
        <IconButton
          label={`Save ${windowState.projectRelativePath}`}
          disabled={!buffer || !buffer.dirty || buffer.saving}
          icon={<Save size={14} />}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void actions.saveTextFileBuffer(windowState.projectRelativePath)}
        />
        {buffer?.externalChange ? (
          <IconButton
            label={`Reload ${windowState.projectRelativePath} from disk`}
            icon={<RefreshCw size={14} />}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void actions.reloadTextFileBuffer(windowState.projectRelativePath)}
          />
        ) : null}
        <IconButton
          label={`Close ${windowState.projectRelativePath}`}
          icon={<X size={14} />}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        />
      </PanelHeader>
      <PanelBody className="floating-panel-body floating-text-editor-body">
        {buffer?.error ? (
          <div className="canvas-text-message" data-canvas-text-editor="true">
            <AlertTriangle size={18} />
            <strong>Text Error</strong>
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
            <span>Loading text</span>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
