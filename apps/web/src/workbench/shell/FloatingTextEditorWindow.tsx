import React, { useEffect } from 'react';
import {
  AlertTriangle,
  FileText,
  RefreshCw,
  Save,
  X
} from 'lucide-react';
import { CanvasMonacoEditor } from '../canvas/CanvasMonacoEditor';
import type { FloatingTextEditorWindowState, TextFileBuffer, WorkbenchActions } from '../../types';
import {
  textEditorWindowIdentity,
  workbenchWindowZIndex,
  type WorkbenchWindowOrderState
} from './workbenchWindowOrder';
import { floatingPanelDragHandleProps } from './FloatingPanel';
import { basenameFromProjectPath, textBufferStatus } from '../services/textEditorWindows';

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
    <section
      className="floating-text-editor-window"
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
      <header className="floating-text-editor-header" {...dragHandleProps}>
        <FileText size={15} />
        <strong>{basenameFromProjectPath(windowState.projectRelativePath)}</strong>
        <small>{windowState.projectRelativePath}</small>
        <span className={status.className}>{status.label}</span>
        <button
          type="button"
          aria-label={`Save ${windowState.projectRelativePath}`}
          disabled={!buffer || !buffer.dirty || buffer.saving}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void actions.saveTextFileBuffer(windowState.projectRelativePath)}
        >
          <Save size={14} />
        </button>
        {buffer?.externalChange ? (
          <button
            type="button"
            aria-label={`Reload ${windowState.projectRelativePath} from disk`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void actions.reloadTextFileBuffer(windowState.projectRelativePath)}
          >
            <RefreshCw size={14} />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={`Close ${windowState.projectRelativePath}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      <div className="floating-text-editor-body">
        {buffer?.error ? (
          <div className="canvas-text-message" data-canvas-text-editor="true">
            <AlertTriangle size={18} />
            <strong>Text Error</strong>
            <span>{buffer.error}</span>
          </div>
        ) : buffer ? (
          <CanvasMonacoEditor
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
      </div>
    </section>
  );
}
