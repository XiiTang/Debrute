import { describe, expect, it, vi } from 'vitest';
import { EditorState, type Transaction } from '@codemirror/state';
import { history, undoDepth } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { syntaxTreeAvailable } from '@codemirror/language';
import {
  canvasTextEditorApplyInitialScroll,
  canvasTextEditorApplyFocusRequest,
  canvasTextEditorCancelInlineEditKeyBinding,
  canvasTextEditorEnsureVisibleSyntaxReady,
  canvasTextEditorExternalValueSyncAnnotation,
  canvasTextEditorKeymap,
  canvasTextEditorSyncExternalValue,
  canvasTextEditorUpdateListener,
  type CanvasTextEditorCallbackRef
} from './CanvasTextEditorRuntime';

describe('CanvasTextEditorRuntime', () => {
  it('binds Mod-s to save', () => {
    const callbacks: CanvasTextEditorCallbackRef = {
      current: {
        onChange: vi.fn(),
        onSave: vi.fn(),
        onToggleWordWrap: vi.fn(),
        onCancel: vi.fn()
      }
    };
    const binding = canvasTextEditorKeymap(callbacks).find((item) => item.key === 'Mod-s');

    if (!binding?.run) {
      throw new Error('Missing Mod-s binding');
    }
    expect(binding.run({} as never)).toBe(true);
    expect(callbacks.current.onSave).toHaveBeenCalledTimes(1);
  });

  it('binds Alt-z to word wrap', () => {
    const callbacks: CanvasTextEditorCallbackRef = {
      current: {
        onChange: vi.fn(),
        onSave: vi.fn(),
        onToggleWordWrap: vi.fn(),
        onCancel: vi.fn()
      }
    };
    const binding = canvasTextEditorKeymap(callbacks).find((item) => item.key === 'Alt-z');

    if (!binding?.run) {
      throw new Error('Missing Alt-z binding');
    }
    expect(binding.run({} as never)).toBe(true);
    expect(callbacks.current.onToggleWordWrap).toHaveBeenCalledTimes(1);
  });

  it('includes CodeMirror search key bindings', () => {
    const callbacks: CanvasTextEditorCallbackRef = {
      current: {
        onChange: vi.fn(),
        onSave: vi.fn(),
        onToggleWordWrap: vi.fn(),
        onCancel: vi.fn()
      }
    };

    expect(canvasTextEditorKeymap(callbacks).some((item) => item.key === 'Mod-f')).toBe(true);
  });

  it('binds Escape to cancel inline editing when CodeMirror has not handled it first', () => {
    const callbacks: CanvasTextEditorCallbackRef = {
      current: {
        onChange: vi.fn(),
        onSave: vi.fn(),
        onToggleWordWrap: vi.fn(),
        onCancel: vi.fn()
      }
    };
    const binding = canvasTextEditorCancelInlineEditKeyBinding(callbacks);

    expect(binding.key).toBe('Escape');
    expect(binding.run?.({} as never)).toBe(true);
    expect(callbacks.current.onCancel).toHaveBeenCalledTimes(1);
    expect(canvasTextEditorKeymap(callbacks).some((item) => (
      item.key === 'Escape' && item.preventDefault === true
    ))).toBe(true);
  });

  it('emits document changes through onChange', () => {
    const callbacks: CanvasTextEditorCallbackRef = {
      current: {
        onChange: vi.fn(),
        onSave: vi.fn(),
        onToggleWordWrap: vi.fn(),
        onCancel: vi.fn()
      }
    };
    const listener = canvasTextEditorUpdateListener(callbacks);

    listener({
      docChanged: true,
      transactions: [],
      state: EditorState.create({ doc: '# Changed' })
    });

    expect(callbacks.current.onChange).toHaveBeenCalledWith('# Changed');
  });

  it('ignores non-document updates', () => {
    const callbacks: CanvasTextEditorCallbackRef = {
      current: {
        onChange: vi.fn(),
        onSave: vi.fn(),
        onToggleWordWrap: vi.fn(),
        onCancel: vi.fn()
      }
    };
    const listener = canvasTextEditorUpdateListener(callbacks);

    listener({
      docChanged: false,
      transactions: [],
      state: EditorState.create({ doc: '# Same' })
    });

    expect(callbacks.current.onChange).not.toHaveBeenCalled();
  });

  it('synchronizes external values through annotated transactions only when the document differs', () => {
    const callbacks: CanvasTextEditorCallbackRef = {
      current: {
        onChange: vi.fn(),
        onSave: vi.fn(),
        onToggleWordWrap: vi.fn(),
        onCancel: vi.fn()
      }
    };
    const listener = canvasTextEditorUpdateListener(callbacks);
    let state = EditorState.create({
      doc: 'User draft',
      extensions: [history()]
    });
    const dispatchedTransactions: Transaction[] = [];
    const view = {
      get state() {
        return state;
      },
      dispatch(transaction: Transaction) {
        dispatchedTransactions.push(transaction);
        state = transaction.state;
      }
    };

    expect(canvasTextEditorSyncExternalValue(view, 'User draft')).toBe(false);
    expect(dispatchedTransactions).toHaveLength(0);

    expect(canvasTextEditorSyncExternalValue(view, 'Disk refresh')).toBe(true);

    expect(dispatchedTransactions).toHaveLength(1);
    const [transaction] = dispatchedTransactions;
    expect(transaction!.annotation(canvasTextEditorExternalValueSyncAnnotation)).toBe(true);
    expect(state.doc.toString()).toBe('Disk refresh');
    expect(undoDepth(state)).toBe(0);
    listener({
      docChanged: transaction!.docChanged,
      state,
      transactions: [transaction!]
    });
    expect(callbacks.current.onChange).not.toHaveBeenCalled();
  });

  it('applies initial scroll to the CodeMirror scroller and requests measurement', () => {
    const requestMeasure = vi.fn();
    const scrollDOM = {
      scrollTop: 0,
      scrollLeft: 0
    };

    canvasTextEditorApplyInitialScroll({ scrollDOM, requestMeasure }, {
      scrollTop: 84,
      scrollLeft: 12
    });

    expect(scrollDOM.scrollTop).toBe(84);
    expect(scrollDOM.scrollLeft).toBe(12);
    expect(requestMeasure).toHaveBeenCalledTimes(1);
  });

  it('focuses the editor and dispatches a collapsed selection from a focus request coordinate', () => {
    let state = EditorState.create({ doc: 'first\nsecond' });
    const dispatch = vi.fn((transaction: Transaction) => {
      state = transaction.state;
    });
    const focus = vi.fn();
    const posAtCoords = vi.fn(() => 8);
    const view = {
      get state() {
        return state;
      },
      documentTop: 80,
      defaultLineHeight: 18,
      focus,
      dispatch,
      posAtCoords,
      coordsAtPos: vi.fn(() => ({ left: 144, right: 144, top: 88, bottom: 106 })),
      lineBlockAtHeight: vi.fn()
    };

    canvasTextEditorApplyFocusRequest(view, {
      requestId: 1,
      clientX: 144,
      clientY: 96
    });

    expect(focus).toHaveBeenCalledTimes(1);
    expect(posAtCoords).toHaveBeenCalledWith({ x: 144, y: 96 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(state.selection.main.anchor).toBe(8);
    expect(state.selection.main.head).toBe(8);
  });

  it('uses the line block under the focus request when the coordinate resolves to the document start', () => {
    let state = EditorState.create({ doc: '# Notes\n\nClick into this text preview.\nSecond line for caret placement.\n' });
    const dispatch = vi.fn((transaction: Transaction) => {
      state = transaction.state;
    });
    const view = {
      get state() {
        return state;
      },
      documentTop: 370,
      defaultLineHeight: 120,
      focus: vi.fn(),
      dispatch,
      posAtCoords: vi.fn(() => 0),
      coordsAtPos: vi.fn((position: number) => {
        if (position === 0) {
          return { left: 282, right: 282, top: 370, bottom: 388 };
        }
        return { left: 282, right: 282, top: 442, bottom: 460 };
      }),
      lineBlockAtHeight: vi.fn(() => ({
        from: state.doc.length,
        to: state.doc.length,
        top: 72,
        height: 18,
        bottom: 90
      }))
    };

    canvasTextEditorApplyFocusRequest(view, {
      requestId: 1,
      clientX: 406,
      clientY: 436
    });

    expect(view.posAtCoords).toHaveBeenCalledWith({ x: 406, y: 436 });
    expect(view.lineBlockAtHeight).toHaveBeenCalledWith(66);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(state.selection.main.anchor).toBe(state.doc.length);
    expect(state.selection.main.head).toBe(state.doc.length);
  });

  it('uses the line block under the focus request when the resolved position has no measured rectangle yet', () => {
    let state = EditorState.create({ doc: '# Notes\n\nClick into this text preview.\nSecond line for caret placement.\n' });
    const dispatch = vi.fn((transaction: Transaction) => {
      state = transaction.state;
    });
    const view = {
      get state() {
        return state;
      },
      documentTop: 370,
      defaultLineHeight: 18,
      focus: vi.fn(),
      dispatch,
      posAtCoords: vi.fn(() => 0),
      coordsAtPos: vi.fn(() => null),
      lineBlockAtHeight: vi.fn(() => ({
        from: state.doc.length,
        to: state.doc.length,
        top: 72,
        height: 18,
        bottom: 90
      }))
    };

    canvasTextEditorApplyFocusRequest(view, {
      requestId: 1,
      clientX: 406,
      clientY: 436
    });

    expect(view.lineBlockAtHeight).toHaveBeenCalledWith(66);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(state.selection.main.anchor).toBe(state.doc.length);
    expect(state.selection.main.head).toBe(state.doc.length);
  });

  it('uses the line block under the focus request when the coordinate has no resolved position yet', () => {
    let state = EditorState.create({ doc: '# Notes\n\nClick into this text preview.\nSecond line for caret placement.\n' });
    const dispatch = vi.fn((transaction: Transaction) => {
      state = transaction.state;
    });
    const view = {
      get state() {
        return state;
      },
      documentTop: 370,
      defaultLineHeight: 18,
      focus: vi.fn(),
      dispatch,
      posAtCoords: vi.fn(() => null),
      coordsAtPos: vi.fn(),
      lineBlockAtHeight: vi.fn(() => ({
        from: state.doc.length,
        to: state.doc.length,
        top: 72,
        height: 18,
        bottom: 90
      }))
    };

    canvasTextEditorApplyFocusRequest(view, {
      requestId: 1,
      clientX: 406,
      clientY: 436
    });

    expect(view.lineBlockAtHeight).toHaveBeenCalledWith(66);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(state.selection.main.anchor).toBe(state.doc.length);
    expect(state.selection.main.head).toBe(state.doc.length);
  });

  it('forces syntax parsing through the visible range before capture readiness', () => {
    const content = jsonlFixture();
    let state = EditorState.create({
      doc: content,
      extensions: [json()]
    });
    const view = {
      get state() {
        return state;
      },
      viewport: { from: 0, to: state.doc.length },
      visibleRanges: [{ from: 0, to: state.doc.length }],
      dispatch(spec: Parameters<typeof state.update>[0]) {
        state = state.update(spec).state;
      }
    };

    expect(syntaxTreeAvailable(state, state.doc.length)).toBe(false);
    expect(canvasTextEditorEnsureVisibleSyntaxReady(view as never)).toBe(true);
    expect(syntaxTreeAvailable(state, state.doc.length)).toBe(true);
  });
});

function jsonlFixture(): string {
  return Array.from({ length: 10 }, (_, index) => JSON.stringify({
    index: index + 1,
    model: 'gpt-image-2',
    outputPath: `generated/wedding-invitation/${'nested/'.repeat(6)}set-${index + 1}-${'detail-'.repeat(20)}image.png`,
    status: 'ok',
    attempt: 1,
    durationSeconds: 120 + index,
    artifacts: [{
      artifactId: `asset-${index}-${'x'.repeat(40)}`,
      projectRelativePath: `generated/wedding-invitation/${'nested/'.repeat(6)}set-${index + 1}-${'detail-'.repeat(20)}image.png`,
      available: true,
      title: `set-${index + 1}-${'detail-'.repeat(12)}image.png`,
      mimeType: 'image/png',
      width: 853,
      height: 1844
    }]
  })).join('\n');
}
