import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { FloatingTextEditorWindow } from './FloatingTextEditorWindow';
import { textEditorWindowIdentity } from './workbenchWindowOrder';
import { FLOATING_PANEL_TITLEBAR_HEIGHT } from './windowBounds';

describe('FloatingTextEditorWindow', () => {
  it('renders the shared CodeMirror text editor surface', () => {
    const html = renderToStaticMarkup(
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
      />
    );

    expect(html).toContain('floating-text-editor-window');
    expect(html).toContain(`--db-floating-panel-titlebar-height:${FLOATING_PANEL_TITLEBAR_HEIGHT}px`);
    expect(html).toContain('data-canvas-local-wheel="true"');
    expect(html).toContain('data-editor-engine="codemirror"');
    expect(html).toContain('data-canvas-text-editor="true"');
    expect(html).toContain('data-editor-mode="edit"');
    expect(html).not.toContain(`data-editor-mode="${'pre'}${'view'}"`);
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
    reloadTextFileBuffer: async () => undefined,
    updateTextFileBuffer: () => undefined,
    toggleTextFileWordWrap: () => undefined
  } as unknown as WorkbenchActions;
}
