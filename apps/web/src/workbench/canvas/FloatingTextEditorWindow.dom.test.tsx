import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { WorkbenchFloatingTextEditorWindowFeature } from './FloatingTextEditorWindowFeature.js';
import { textEditorWindowIdentity } from '../shell/workbenchWindowOrder';
import { FLOATING_TEXT_EDITOR_TITLEBAR_HEIGHT } from '../shell/windowBounds';

vi.mock('./CanvasTextEditor.js', () => {
  return {
    CanvasTextEditor: () => (
      <div
        data-canvas-local-wheel="true"
        data-editor-engine="codemirror"
        data-canvas-text-editor="true"
        data-editor-mode="edit"
      />
    )
  };
});

describe('WorkbenchFloatingTextEditorWindowFeature', { tags: ['canvas-text'] }, () => {
  it('loads the shared CodeMirror text editor surface inside the real feature boundary', async () => {
    const rendered = await renderFeature();
    const html = rendered.container.innerHTML;

    expect(html).toContain('floating-text-editor-window');
    expect(
      rendered.container.querySelector<HTMLElement>('.floating-text-editor-window')
        ?.style.getPropertyValue('--db-floating-text-editor-titlebar-height')
    ).toBe(`${FLOATING_TEXT_EDITOR_TITLEBAR_HEIGHT}px`);
    expect(html).toContain('data-canvas-local-wheel="true"');
    expect(html).toContain('data-editor-engine="codemirror"');
    expect(html).toContain('data-canvas-text-editor="true"');
    expect(html).toContain('data-editor-mode="edit"');
    expect(html).not.toContain(`data-editor-mode="${'pre'}${'view'}"`);
    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });

  it('renders resize handles for the expanded text editor panel', async () => {
    const rendered = await renderFeature();
    const html = rendered.container.innerHTML;

    expect(html.match(/class="floating-panel-resize-handle /g) ?? []).toHaveLength(8);
    expect(html).toContain('floating-panel-resize-handle--se');
    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });
});

async function renderFeature() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <WorkbenchFloatingTextEditorWindowFeature
        locale="en"
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
    await Promise.resolve();
  });
  await vi.waitFor(() => {
    expect(container.querySelector('[data-canvas-text-editor="true"]')).not.toBeNull();
  });
  return { container, root };
}

function textBuffer(): TextFileBuffer {
  return {
    projectRelativePath: 'notes/readme.md',
    content: '# Notes',
    language: 'markdown',
    wordWrap: false,
    dirty: false,
    saving: false,
    baseRevision: 'rev-a',
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
