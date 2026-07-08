import type { Extension } from '@codemirror/state';
import { Annotation, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import {
  drawSelection,
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
import { CANVAS_TEXT_SURFACE_METRICS } from './CanvasTextSurface';

export const CANVAS_TEXT_EDITOR_SYNTAX_HIGHLIGHT_STYLE_ID = 'codemirror-default-highlight-style-v1';

const CANVAS_TEXT_EDITOR_CURSOR_SCROLL_MARGIN_LINES = 2;

export const CANVAS_TEXT_EDITOR_CURSOR_SCROLL_MARGIN = {
  x: CANVAS_TEXT_SURFACE_METRICS.linePaddingInlinePx,
  y: Math.ceil(CANVAS_TEXT_SURFACE_METRICS.lineHeightPx * CANVAS_TEXT_EDITOR_CURSOR_SCROLL_MARGIN_LINES)
} as const;

export interface CanvasTextEditorCallbacks {
  onChange: (value: string) => void;
  onSave: () => void;
  onToggleWordWrap: () => void;
  onCancel: () => void;
}

export interface CanvasTextEditorFocusRequest {
  requestId: number;
  clientX: number;
  clientY: number;
}

export interface CanvasTextEditorCallbackRef {
  current: CanvasTextEditorCallbacks;
}

export interface CanvasTextEditorScrollableView {
  scrollDOM: {
    scrollTop: number;
    scrollLeft: number;
  };
  requestMeasure: () => void;
}

interface CanvasTextEditorFocusLineBlock {
  readonly from: number;
  readonly to: number;
  readonly top: number;
  readonly height: number;
}

interface CanvasTextEditorFocusPositionRect {
  readonly top: number;
  readonly bottom: number;
}

export interface CanvasTextEditorFocusableView {
  readonly state: EditorState;
  readonly documentTop: number;
  readonly defaultLineHeight: number;
  focus: () => void;
  dispatch: (transaction: Transaction) => void;
  posAtCoords: (coords: { x: number; y: number }, precise?: false) => number | null;
  coordsAtPos: (pos: number, side?: -1 | 1) => CanvasTextEditorFocusPositionRect | null;
  lineBlockAtHeight: (height: number) => CanvasTextEditorFocusLineBlock;
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
  view.requestMeasure();
}

export function canvasTextEditorApplyFocusRequest(
  view: CanvasTextEditorFocusableView,
  request: CanvasTextEditorFocusRequest
): void {
  view.focus();
  const position = canvasTextEditorFocusRequestPosition(view, request);
  view.dispatch(view.state.update({
    selection: EditorSelection.cursor(position)
  }));
}

function canvasTextEditorFocusRequestPosition(
  view: CanvasTextEditorFocusableView,
  request: CanvasTextEditorFocusRequest
): number {
  const coords = { x: request.clientX, y: request.clientY };
  const position = view.posAtCoords(coords);
  if (position === null) {
    return canvasTextEditorFocusRequestLineBlockPosition(view, request);
  }

  const positionRect = view.coordsAtPos(position);
  if (positionRect && canvasTextEditorCoordinateMatchesPositionLine(view, positionRect, request.clientY)) {
    return position;
  }

  return canvasTextEditorFocusRequestLineBlockPosition(view, request);
}

function canvasTextEditorFocusRequestLineBlockPosition(
  view: CanvasTextEditorFocusableView,
  request: CanvasTextEditorFocusRequest
): number {
  const lineBlock = view.lineBlockAtHeight(request.clientY - view.documentTop);
  if (lineBlock.from === lineBlock.to) {
    return lineBlock.from;
  }

  const linePosition = view.posAtCoords({
    x: request.clientX,
    y: view.documentTop + lineBlock.top + (lineBlock.height / 2)
  }, false);
  if (
    linePosition !== null
    && linePosition >= lineBlock.from
    && linePosition <= lineBlock.to
  ) {
    return linePosition;
  }
  return lineBlock.to;
}

function canvasTextEditorCoordinateMatchesPositionLine(
  view: CanvasTextEditorFocusableView,
  rect: CanvasTextEditorFocusPositionRect,
  clientY: number
): boolean {
  const rectHeight = rect.bottom - rect.top;
  const lineHeight = rectHeight > 0 ? rectHeight : view.defaultLineHeight;
  const tolerance = Math.max(1, lineHeight / 2);
  return clientY >= rect.top - tolerance && clientY <= rect.bottom + tolerance;
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

export function canvasTextEditorCursorScrollMarginExtension(): Extension {
  return EditorView.cursorScrollMargin.of(CANVAS_TEXT_EDITOR_CURSOR_SCROLL_MARGIN);
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
    drawSelection(),
    search(),
    syntaxHighlighting(defaultHighlightStyle),
    keymap.of(canvasTextEditorKeymap(callbacks)),
    EditorView.updateListener.of(canvasTextEditorUpdateListener(callbacks)),
    canvasTextEditorCursorScrollMarginExtension(),
    canvasTextEditorTheme()
  ];
}
