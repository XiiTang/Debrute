import type { WorkbenchLocale } from '@debrute/app-protocol';
import type {
  FloatingTextEditorWindowState,
  TextFileBuffer,
  WorkbenchActions
} from '../../types.js';
import { I18nProvider } from '../i18n/index.js';
import type { WorkbenchWindowRect } from '../shell/windowBounds.js';
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
  viewportRect,
  buffer,
  actions,
  onClose,
  onCommitRect
}: {
  locale: WorkbenchLocale;
  windowState: FloatingTextEditorWindowState;
  viewportRect: WorkbenchWindowRect;
  buffer: TextFileBuffer | undefined;
  actions: WorkbenchActions;
  onClose(): void;
  onCommitRect(rect: WorkbenchWindowRect): void;
}): React.ReactElement {
  return (
    <I18nProvider locale={locale}>
      <FloatingTextEditorWindowShell
        windowState={windowState}
        viewportRect={viewportRect}
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
        onClose={onClose}
        onCommitRect={onCommitRect}
      />
    </I18nProvider>
  );
}
