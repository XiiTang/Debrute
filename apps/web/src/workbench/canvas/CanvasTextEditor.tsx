import React from 'react';
import type { ProjectTextLanguageId } from '@debrute/project-core';
import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { codeMirrorLanguageExtensionForProjectTextLanguage } from './textEditorCodeMirrorLanguages';
import { canvasTextSurfaceCssVariables } from './CanvasTextSurface';
import {
  canvasTextEditorBaseExtensions,
  canvasTextEditorReadOnlyExtension,
  canvasTextEditorSyncExternalValue,
  canvasTextEditorWordWrapExtension,
  type CanvasTextEditorCallbackRef,
  type CanvasTextEditorCallbacks
} from './CanvasTextEditorRuntime';

interface CanvasTextEditorCompartments {
  language: Compartment;
  readOnly: Compartment;
  wordWrap: Compartment;
}

export function CanvasTextEditor({
  value,
  language,
  wordWrap,
  readOnly,
  focusRequest,
  initialScrollTop,
  onScrollTopChange,
  onEditorBlur,
  onChange,
  onSave,
  onToggleWordWrap
}: {
  value: string;
  language: ProjectTextLanguageId;
  wordWrap: boolean;
  readOnly?: boolean;
  focusRequest?: { requestId: number; clientX: number; clientY: number } | undefined;
  initialScrollTop?: number | undefined;
  onScrollTopChange?: ((scrollTop: number) => void) | undefined;
  onEditorBlur?: (() => void) | undefined;
  onChange: (value: string) => void;
  onSave: () => void;
  onToggleWordWrap: () => void;
}): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const callbacksRef = React.useRef<CanvasTextEditorCallbacks>({
    onChange,
    onSave,
    onToggleWordWrap,
    onCancel: () => undefined
  });
  const compartmentsRef = React.useRef<CanvasTextEditorCompartments | null>(null);

  if (!compartmentsRef.current) {
    compartmentsRef.current = {
      language: new Compartment(),
      readOnly: new Compartment(),
      wordWrap: new Compartment()
    };
  }

  React.useEffect(() => {
    callbacksRef.current = {
      onChange,
      onSave,
      onToggleWordWrap,
      onCancel: () => {
        const view = viewRef.current;
        if (view) {
          onScrollTopChange?.(view.scrollDOM.scrollTop);
          view.contentDOM.blur();
        }
        onEditorBlur?.();
      }
    };
  }, [onChange, onEditorBlur, onSave, onScrollTopChange, onToggleWordWrap]);

  React.useEffect(() => {
    const host = hostRef.current;
    const compartments = compartmentsRef.current;
    if (!host || !compartments || viewRef.current) {
      return;
    }

    const callbackRef: CanvasTextEditorCallbackRef = callbacksRef;
    const view = new EditorView({
      doc: value,
      extensions: [
        ...canvasTextEditorBaseExtensions(callbackRef),
        compartments.language.of(codeMirrorLanguageExtensionForProjectTextLanguage(language)),
        compartments.readOnly.of(canvasTextEditorReadOnlyExtension(readOnly)),
        compartments.wordWrap.of(canvasTextEditorWordWrapExtension(wordWrap))
      ],
      parent: host
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    canvasTextEditorSyncExternalValue(view, value);
  }, [value]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || initialScrollTop === undefined) {
      return;
    }
    view.scrollDOM.scrollTop = initialScrollTop;
  }, [initialScrollTop]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || !focusRequest) {
      return;
    }
    view.focus();
    const position = view.posAtCoords({
      x: focusRequest.clientX,
      y: focusRequest.clientY
    });
    if (position !== null) {
      view.dispatch({
        selection: { anchor: position },
        scrollIntoView: true
      });
    }
  }, [focusRequest?.requestId]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || !onScrollTopChange) {
      return;
    }
    const handleScroll = () => {
      onScrollTopChange(view.scrollDOM.scrollTop);
    };
    view.scrollDOM.addEventListener('scroll', handleScroll);
    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll);
    };
  }, [onScrollTopChange]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || !onEditorBlur) {
      return;
    }
    let blurTimer: number | undefined;
    const handleFocusOut = () => {
      if (blurTimer !== undefined) {
        window.clearTimeout(blurTimer);
      }
      blurTimer = window.setTimeout(() => {
        blurTimer = undefined;
        const activeElement = document.activeElement;
        if (!(activeElement instanceof Node) || !view.dom.contains(activeElement)) {
          onScrollTopChange?.(view.scrollDOM.scrollTop);
          onEditorBlur();
        }
      }, 0);
    };
    const handleFocusIn = () => {
      if (blurTimer !== undefined) {
        window.clearTimeout(blurTimer);
        blurTimer = undefined;
      }
    };
    view.dom.addEventListener('focusout', handleFocusOut);
    view.dom.addEventListener('focusin', handleFocusIn);
    return () => {
      if (blurTimer !== undefined) {
        window.clearTimeout(blurTimer);
      }
      view.dom.removeEventListener('focusout', handleFocusOut);
      view.dom.removeEventListener('focusin', handleFocusIn);
    };
  }, [onEditorBlur, onScrollTopChange]);

  React.useEffect(() => {
    const view = viewRef.current;
    const compartments = compartmentsRef.current;
    if (!view || !compartments) {
      return;
    }

    view.dispatch({
      effects: [
        compartments.language.reconfigure(codeMirrorLanguageExtensionForProjectTextLanguage(language)),
        compartments.readOnly.reconfigure(canvasTextEditorReadOnlyExtension(readOnly)),
        compartments.wordWrap.reconfigure(canvasTextEditorWordWrapExtension(wordWrap))
      ]
    });
  }, [language, readOnly, wordWrap]);

  return (
    <div
      ref={hostRef}
      data-canvas-text-editor="true"
      data-editor-engine="codemirror"
      data-editor-mode="edit"
      data-word-wrap={wordWrap ? 'on' : 'off'}
      className="canvas-text-editor canvas-text-editor--edit"
      style={canvasTextSurfaceCssVariables() as React.CSSProperties}
    />
  );
}
