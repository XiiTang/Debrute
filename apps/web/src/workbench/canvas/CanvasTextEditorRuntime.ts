import type { Extension } from '@codemirror/state';
import { Annotation, EditorState, Transaction } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  type KeyBinding,
  type ViewUpdate
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';

export interface CanvasTextEditorCallbacks {
  onChange: (value: string) => void;
  onSave: () => void;
  onToggleWordWrap: () => void;
}

export interface CanvasTextEditorCallbackRef {
  current: CanvasTextEditorCallbacks;
}

export const canvasTextEditorExternalValueSyncAnnotation = Annotation.define<boolean>();

export function canvasTextEditorExternalValueSyncAnnotations() {
  return [
    canvasTextEditorExternalValueSyncAnnotation.of(true),
    Transaction.addToHistory.of(false)
  ];
}

export function canvasTextEditorKeymap(callbacks: CanvasTextEditorCallbackRef): readonly KeyBinding[] {
  return [
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        callbacks.current.onSave();
        return true;
      }
    },
    {
      key: 'Alt-z',
      preventDefault: true,
      run: () => {
        callbacks.current.onToggleWordWrap();
        return true;
      }
    },
    ...searchKeymap,
    ...defaultKeymap,
    ...historyKeymap
  ];
}

export function canvasTextEditorUpdateListener(
  callbacks: CanvasTextEditorCallbackRef
): (update: Pick<ViewUpdate, 'docChanged' | 'state' | 'transactions'>) => void {
  return (update) => {
    const externalValueSync = update.transactions.some((transaction) => (
      transaction.annotation(canvasTextEditorExternalValueSyncAnnotation) === true
    ));
    if (update.docChanged && !externalValueSync) {
      callbacks.current.onChange(update.state.doc.toString());
    }
  };
}

export function canvasTextEditorSyncExternalValue(
  view: {
    readonly state: EditorState;
    dispatch: (transaction: Transaction) => void;
  },
  value: string
): boolean {
  const currentValue = view.state.doc.toString();
  if (currentValue === value) {
    return false;
  }

  view.dispatch(view.state.update({
    annotations: canvasTextEditorExternalValueSyncAnnotations(),
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: value
    }
  }));
  return true;
}

export function canvasTextEditorReadOnlyExtension(readOnly: boolean | undefined): Extension {
  const isReadOnly = readOnly === true;
  return [
    EditorState.readOnly.of(isReadOnly),
    EditorView.editable.of(!isReadOnly)
  ];
}

export function canvasTextEditorWordWrapExtension(wordWrap: boolean): Extension {
  return wordWrap ? EditorView.lineWrapping : [];
}

export function canvasTextEditorTheme(): Extension {
  return EditorView.theme({
    '&': {
      height: '100%',
      color: 'var(--db-text)',
      backgroundColor: 'transparent',
      fontSize: '12px'
    },
    '&.cm-focused': {
      outline: 'none'
    },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      overscrollBehavior: 'contain'
    },
    '.cm-content': {
      minHeight: '100%',
      padding: '6px 0',
      caretColor: 'var(--db-text)'
    },
    '.cm-line': {
      padding: '0 8px'
    },
    '.cm-gutters': {
      color: 'var(--db-text-muted)',
      backgroundColor: 'transparent',
      border: 'none'
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent'
    },
    '.cm-panels': {
      color: 'var(--db-text)',
      backgroundColor: 'var(--db-surface-2)',
      borderColor: 'var(--db-border)'
    },
    '.cm-panel.cm-search': {
      padding: '6px',
      fontSize: '12px'
    },
    '.cm-panel.cm-search input': {
      color: 'var(--db-text)',
      backgroundColor: 'var(--db-bg)',
      border: '1px solid var(--db-border)',
      borderRadius: '4px',
      minWidth: '96px',
      maxWidth: '160px'
    },
    '.cm-panel.cm-search button': {
      color: 'var(--db-text)',
      backgroundColor: 'var(--db-surface-3)',
      border: '1px solid var(--db-border)',
      borderRadius: '4px'
    }
  }, { dark: true });
}

export function canvasTextEditorBaseExtensions(callbacks: CanvasTextEditorCallbackRef): Extension[] {
  return [
    history(),
    lineNumbers(),
    search(),
    syntaxHighlighting(defaultHighlightStyle),
    keymap.of(canvasTextEditorKeymap(callbacks)),
    EditorView.updateListener.of(canvasTextEditorUpdateListener(callbacks)),
    canvasTextEditorTheme()
  ];
}
