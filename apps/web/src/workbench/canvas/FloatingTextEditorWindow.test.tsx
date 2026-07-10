import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { FloatingTextEditorWindow } from './FloatingTextEditorWindow';
import { textEditorWindowIdentity } from '../shell/workbenchWindowOrder';
import { FLOATING_TEXT_EDITOR_TITLEBAR_HEIGHT } from '../shell/windowBounds';
import { I18nProvider } from '../i18n';

function renderStaticWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      {element}
    </I18nProvider>
  );
}

describe('FloatingTextEditorWindow', () => {
  it('renders the shared CodeMirror text editor surface', () => {
    const html = renderStaticWithI18n(
      <FloatingTextEditorWindow
        windowState={{
          projectRelativePath: 'notes/readme.md',
          open: true,
          x: 20,
          y: 30,
          width: 640,
          height: 420
        }}
        orderState={{
          orderBackToFront: [textEditorWindowIdentity('notes/readme.md')],
          focusedWindow: textEditorWindowIdentity('notes/readme.md')
        }}
        buffer={textBuffer()}
        actions={actionsFixture()}
        onBringToFront={() => undefined}
        onClose={() => undefined}
        onDrag={() => undefined}
        onResize={() => undefined}
      />
    );

    expect(html).toContain('floating-text-editor-window');
    expect(html).toContain(`--db-floating-text-editor-titlebar-height:${FLOATING_TEXT_EDITOR_TITLEBAR_HEIGHT}px`);
    expect(html).toContain('data-canvas-local-wheel="true"');
    expect(html).toContain('data-editor-engine="codemirror"');
    expect(html).toContain('data-canvas-text-editor="true"');
    expect(html).toContain('data-editor-mode="edit"');
    expect(html).not.toContain(`data-editor-mode="${'pre'}${'view'}"`);
  });

  it('renders resize handles for the expanded text editor panel', () => {
    const html = renderStaticWithI18n(
      <FloatingTextEditorWindow
        windowState={{
          projectRelativePath: 'notes/readme.md',
          open: true,
          x: 20,
          y: 30,
          width: 640,
          height: 420
        }}
        orderState={{
          orderBackToFront: [textEditorWindowIdentity('notes/readme.md')],
          focusedWindow: textEditorWindowIdentity('notes/readme.md')
        }}
        buffer={textBuffer()}
        actions={actionsFixture()}
        onBringToFront={() => undefined}
        onClose={() => undefined}
        onDrag={() => undefined}
        onResize={() => undefined}
      />
    );

    expect(html.match(/class="floating-panel-resize-handle /g) ?? []).toHaveLength(8);
    expect(html).toContain('floating-panel-resize-handle--se');
  });
});

function textBuffer(): TextFileBuffer {
  return {
    projectRelativePath: 'notes/readme.md',
    content: '# Notes',
    language: 'markdown',
    wordWrap: false,
    dirty: false,
    saving: false,
    diskRevision: 'rev-a',
    lastSavedRevision: 'rev-a',
    externalChange: false
  };
}

function actionsFixture(): WorkbenchActions {
  return {
    ensureTextFileBuffer: async () => undefined,
    saveTextFileBuffer: async () => undefined,
    discardTextFileBuffer: async () => undefined,
    reloadTextFileBuffer: async () => undefined,
    updateTextFileBuffer: () => undefined,
    toggleTextFileWordWrap: () => undefined
  } as unknown as WorkbenchActions;
}
