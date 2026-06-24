import React from 'react';
import type { ProjectTextLanguageId } from '@debrute/project-core';
import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { codeMirrorLanguageExtensionForProjectTextLanguage } from './textEditorCodeMirrorLanguages';
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
  onChange,
  onSave,
  onToggleWordWrap
}: {
  value: string;
  language: ProjectTextLanguageId;
  wordWrap: boolean;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onToggleWordWrap: () => void;
}): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const callbacksRef = React.useRef<CanvasTextEditorCallbacks>({
    onChange,
    onSave,
    onToggleWordWrap
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
      onToggleWordWrap
    };
  }, [onChange, onSave, onToggleWordWrap]);

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
      data-word-wrap={wordWrap ? 'on' : 'off'}
      className="canvas-text-editor"
    />
  );
}
