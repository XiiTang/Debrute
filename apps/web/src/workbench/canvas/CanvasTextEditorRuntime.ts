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
import {
  defaultHighlightStyle,
  forceParsing,
  language as codeMirrorLanguage,
  syntaxHighlighting,
  syntaxTreeAvailable
} from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';

export const CANVAS_TEXT_EDITOR_SYNTAX_HIGHLIGHT_STYLE_ID = 'codemirror-default-highlight-style-v1';

export interface CanvasTextEditorCallbacks {
  onChange: (value: string) => void;
  onSave: () => void;
  onToggleWordWrap: () => void;
  onCancel: () => void;
}

export interface CanvasTextEditorCallbackRef {
  current: CanvasTextEditorCallbacks;
}

export interface CanvasTextEditorScrollableView {
  scrollDOM: {
    scrollTop: number;
    scrollLeft: number;
  };
}

export type CanvasTextEditorSyntaxReadyView = Pick<EditorView, 'state' | 'viewport' | 'visibleRanges' | 'dispatch'>;

const CANVAS_TEXT_EDITOR_SYNTAX_READY_TIMEOUT_MS = 50;

export const canvasTextEditorExternalValueSyncAnnotation = Annotation.define<boolean>();

export function canvasTextEditorExternalValueSyncAnnotations() {
  return [
    canvasTextEditorExternalValueSyncAnnotation.of(true),
    Transaction.addToHistory.of(false)
  ];
}

export function canvasTextEditorKeymap(callbacks: CanvasTextEditorCallbackRef): readonly KeyBinding[] {
  const cancelInlineEdit = canvasTextEditorCancelInlineEditKeyBinding(callbacks);
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
    cancelInlineEdit,
    ...defaultKeymap,
    ...historyKeymap
  ];
}

export function canvasTextEditorCancelInlineEditKeyBinding(callbacks: CanvasTextEditorCallbackRef): KeyBinding {
  return {
    key: 'Escape',
    preventDefault: true,
    run: () => {
      callbacks.current.onCancel();
      return true;
    }
  };
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

export function canvasTextEditorApplyInitialScroll(
  view: CanvasTextEditorScrollableView,
  scroll: { scrollTop?: number | undefined; scrollLeft?: number | undefined }
): void {
  view.scrollDOM.scrollTop = scroll.scrollTop ?? 0;
  view.scrollDOM.scrollLeft = scroll.scrollLeft ?? 0;
}

export function canvasTextEditorEnsureVisibleSyntaxReady(view: CanvasTextEditorSyntaxReadyView): boolean {
  if (!view.state.facet(codeMirrorLanguage)) {
    return true;
  }
  const upto = canvasTextEditorVisibleSyntaxEnd(view);
  return syntaxTreeAvailable(view.state, upto)
    || forceParsing(view as EditorView, upto, CANVAS_TEXT_EDITOR_SYNTAX_READY_TIMEOUT_MS);
}

function canvasTextEditorVisibleSyntaxEnd(view: Pick<EditorView, 'state' | 'viewport' | 'visibleRanges'>): number {
  const visibleEnd = view.visibleRanges.reduce(
    (current, range) => Math.max(current, range.to),
    view.viewport.to
  );
  return Math.max(0, Math.min(view.state.doc.length, visibleEnd));
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
      fontSize: 'var(--canvas-text-editor-font-size)'
    },
    '&.cm-focused': {
      outline: 'none'
    },
    '.cm-scroller': {
      fontFamily: 'var(--canvas-text-editor-font-family)',
      lineHeight: 'var(--canvas-text-editor-line-height)',
      overscrollBehavior: 'contain'
    },
    '.cm-content': {
      minHeight: '100%',
      padding: 'var(--canvas-text-editor-content-padding-block) 0',
      caretColor: 'var(--db-text)',
      tabSize: 'var(--canvas-text-editor-tab-size)'
    },
    '.cm-line': {
      padding: '0 var(--canvas-text-editor-line-padding-inline)',
      lineHeight: 'var(--canvas-text-editor-line-height)'
    },
    '.cm-gutters': {
      color: 'var(--db-text-muted)',
      backgroundColor: 'transparent',
      border: 'none'
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent'
    },
    '.cm-gutterElement': {
      paddingLeft: 'var(--canvas-text-editor-gutter-padding-left)',
      paddingRight: 'var(--canvas-text-editor-gutter-padding-right)',
      lineHeight: 'var(--canvas-text-editor-line-height)'
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
