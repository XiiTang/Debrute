import React, { useEffect } from 'react';
import type { FloatingTextEditorWindowState, TextFileBuffer, WorkbenchActions } from '../../types.js';
import { useI18n } from '../i18n/index.js';
import {
  basenameFromProjectPath,
  resolveTextEditorWindowGestureRect,
  textBufferStatus
} from '../services/textEditorWindows.js';
import {
  FloatingWindowResizeHandles,
  floatingWindowRectStyle,
  useFloatingWindowGesture
} from '../shell/floatingWindowGesture.js';
import { textEditorWindowIdentity } from '../shell/workbenchWindowOrder.js';
import { useWorkbenchWindow } from '../shell/WorkbenchWindowHost.js';
import type { WorkbenchWindowRect } from '../shell/windowBounds.js';
import {
  FLOATING_TEXT_EDITOR_TITLEBAR_CSS_PROPERTY,
  FLOATING_TEXT_EDITOR_TITLEBAR_CSS_VALUE
} from '../shell/windowBounds.js';
import {
  AlertTriangle,
  DiscardChangesIcon,
  FileText,
  IconButton,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  RefreshCw,
  Save,
  StatusPill,
  X
} from '../ui/index.js';

export function FloatingTextEditorWindowShell({
  windowState,
  viewportRect,
  buffer,
  actions,
  editor,
  onClose,
  onCommitRect
}: {
  windowState: FloatingTextEditorWindowState;
  viewportRect: WorkbenchWindowRect;
  buffer: TextFileBuffer | undefined;
  actions: WorkbenchActions;
  editor: React.ReactElement;
  onClose(): void;
  onCommitRect(rect: WorkbenchWindowRect): void;
}): React.ReactElement {
  const i18n = useI18n();
  const identity = React.useMemo(
    () => textEditorWindowIdentity(windowState.projectRelativePath),
    [windowState.projectRelativePath]
  );
  const workbenchWindow = useWorkbenchWindow(identity);
  const windowRef = React.useRef<HTMLElement>(null);
  const gesture = useFloatingWindowGesture({
    windowRef,
    rect: windowState,
    onFocus: workbenchWindow.onFocus,
    resolveRect: (candidate, activeGesture) => (
      resolveTextEditorWindowGestureRect(candidate, activeGesture, viewportRect)
    ),
    onCommit: onCommitRect
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
      ref={windowRef}
      className="floating-panel floating-text-editor-window"
      data-testid="floating-text-editor-window"
      data-canvas-local-wheel="true"
      style={{
        ...floatingWindowRectStyle(windowState),
        [FLOATING_TEXT_EDITOR_TITLEBAR_CSS_PROPERTY]: FLOATING_TEXT_EDITOR_TITLEBAR_CSS_VALUE,
        zIndex: workbenchWindow.zIndex
      } as React.CSSProperties}
      onPointerDown={workbenchWindow.onFocus}
    >
      <PanelHeader className="floating-text-editor-header" {...gesture.dragHandleProps}>
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
        ) : buffer ? editor : (
          <div className="canvas-text-message" data-canvas-text-editor="true">
            <FileText size={18} />
            <span>{i18n.t('canvas.node.loadingText')}</span>
          </div>
        )}
      </PanelBody>
      <FloatingWindowResizeHandles resizeHandleProps={gesture.resizeHandleProps} />
    </Panel>
  );
}
