import React from 'react';
import type { ProjectTextLanguageId } from '@debrute/project-core';
import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { codeMirrorLanguageExtensionForProjectTextLanguage } from './textEditorCodeMirrorLanguages';
import { canvasTextSurfaceCssVariables } from './CanvasTextSurface';
import {
  canvasTextEditorApplyInitialScroll,
  canvasTextEditorBaseExtensions,
  canvasTextEditorEnsureVisibleSyntaxReady,
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
  visible,
  initialScrollTop,
  initialScrollLeft,
  onChange,
  onSave,
  onToggleWordWrap,
  onLayoutReady
}: {
  value: string;
  language: ProjectTextLanguageId;
  wordWrap: boolean;
  readOnly?: boolean;
  visible?: boolean | undefined;
  initialScrollTop?: number | undefined;
  initialScrollLeft?: number | undefined;
  onChange: (value: string) => void;
  onSave: () => void;
  onToggleWordWrap: () => void;
  onLayoutReady?: (() => void) | undefined;
}): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const onLayoutReadyRef = React.useRef(onLayoutReady);
  const callbacksRef = React.useRef<CanvasTextEditorCallbacks>({
    onChange,
    onSave,
    onToggleWordWrap,
    onCancel: () => {
      viewRef.current?.contentDOM.blur();
    }
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
        viewRef.current?.contentDOM.blur();
      }
    };
  }, [onChange, onSave, onToggleWordWrap]);

  React.useEffect(() => {
    onLayoutReadyRef.current = onLayoutReady;
  }, [onLayoutReady]);

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
    canvasTextEditorApplyInitialScroll(view, {
      scrollTop: initialScrollTop,
      scrollLeft: initialScrollLeft
    });

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || visible === false) {
      return;
    }
    let cancelled = false;
    let frame: number | undefined;
    const scheduleFrame = (callback: FrameRequestCallback) => {
      frame = window.requestAnimationFrame((time) => {
        frame = undefined;
        callback(time);
      });
    };
    const scheduleSyntaxReadyCheck = () => {
      scheduleFrame(() => {
        if (cancelled) {
          return;
        }
        if (!canvasTextEditorEnsureVisibleSyntaxReady(view)) {
          scheduleSyntaxReadyCheck();
          return;
        }
        scheduleFrame(() => {
          if (!cancelled) {
            onLayoutReadyRef.current?.();
          }
        });
      });
    };
    scheduleFrame(() => {
      view.requestMeasure({
        read: () => undefined,
        write: () => {
          if (cancelled) {
            return;
          }
          scheduleSyntaxReadyCheck();
        }
      });
    });
    return () => {
      cancelled = true;
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [visible]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    canvasTextEditorSyncExternalValue(view, value);
  }, [value]);

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
