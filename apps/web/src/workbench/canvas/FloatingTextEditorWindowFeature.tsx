import type { WorkbenchLocale } from '@debrute/app-protocol';
import type {
  FloatingTextEditorWindowState,
  TextFileBuffer,
  WorkbenchActions
} from '../../types.js';
import { I18nProvider } from '../i18n/index.js';
import type { FloatingPanelResizeInput } from '../shell/floatingPanels.js';
import type { WorkbenchWindowOrderState } from '../shell/workbenchWindowOrder.js';
import React from 'react';
import { FloatingTextEditorWindowShell } from './FloatingTextEditorWindowShell.js';
import { workbenchStartupTimeline } from '../../startup/workbenchStartupTimeline.js';

const CanvasTextEditor = React.lazy(async () => {
  workbenchStartupTimeline.markFeatureRequested('text-editor');
  const module = await import('./CanvasTextEditor.js');
  workbenchStartupTimeline.markFeatureReady('text-editor');
  return { default: module.CanvasTextEditor };
});

export function WorkbenchFloatingTextEditorWindowFeature({
  locale,
  windowState,
  orderState,
  buffer,
  actions,
  onBringToFront,
  onClose,
  onDrag,
  onResize
}: {
  locale: WorkbenchLocale;
  windowState: FloatingTextEditorWindowState;
  orderState: WorkbenchWindowOrderState;
  buffer: TextFileBuffer | undefined;
  actions: WorkbenchActions;
  onBringToFront(): void;
  onClose(): void;
  onDrag(dx: number, dy: number): void;
  onResize(input: FloatingPanelResizeInput): void;
}): React.ReactElement {
  return (
    <I18nProvider locale={locale}>
      <FloatingTextEditorWindowShell
        windowState={windowState}
        orderState={orderState}
        buffer={buffer}
        actions={actions}
        editor={buffer ? (
          <React.Suspense fallback={<div className="canvas-text-message" aria-busy="true" />}>
            <CanvasTextEditor
              value={buffer.content}
              language={buffer.language}
              wordWrap={buffer.wordWrap}
              onChange={(content) => actions.updateTextFileBuffer(windowState.projectRelativePath, content)}
              onSave={() => void actions.saveTextFileBuffer(windowState.projectRelativePath)}
              onToggleWordWrap={() => actions.toggleTextFileWordWrap(windowState.projectRelativePath)}
            />
          </React.Suspense>
        ) : <></>}
        onBringToFront={onBringToFront}
        onClose={onClose}
        onDrag={onDrag}
        onResize={onResize}
      />
    </I18nProvider>
  );
}
