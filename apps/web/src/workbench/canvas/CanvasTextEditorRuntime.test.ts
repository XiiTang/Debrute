import { describe, expect, it, vi } from 'vitest';
import { EditorState, type Transaction } from '@codemirror/state';
import { history, undoDepth } from '@codemirror/commands';
import {
  canvasTextEditorApplyInitialScroll,
  canvasTextEditorCancelInlineEditKeyBinding,
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

  it('applies initial scroll to the CodeMirror scroller', () => {
    const scrollDOM = {
      scrollTop: 0,
      scrollLeft: 0
    };

    canvasTextEditorApplyInitialScroll({ scrollDOM }, {
      scrollTop: 84,
      scrollLeft: 12
    });

    expect(scrollDOM).toEqual({
      scrollTop: 84,
      scrollLeft: 12
    });
  });
});
