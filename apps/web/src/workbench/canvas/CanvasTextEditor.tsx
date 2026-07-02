import React from 'react';
import type { ProjectTextLanguageId } from '@debrute/project-core';
import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { codeMirrorLanguageExtensionForProjectTextLanguage } from './textEditorCodeMirrorLanguages';
import { canvasTextSurfaceCssVariables } from './CanvasTextSurface';
import {
  canvasTextEditorApplyFocusRequest,
  canvasTextEditorApplyInitialScroll,
  canvasTextEditorBaseExtensions,
  canvasTextEditorEnsureVisibleSyntaxReady,
  canvasTextEditorReadOnlyExtension,
  canvasTextEditorSyncExternalValue,
  canvasTextEditorWordWrapExtension,
  type CanvasTextEditorCallbackRef,
  type CanvasTextEditorCallbacks,
  type CanvasTextEditorFocusRequest
} from './CanvasTextEditorRuntime';

interface CanvasTextEditorCompartments {
  language: Compartment;
  readOnly: Compartment;
  wordWrap: Compartment;
}

export interface CanvasTextEditorScrollPosition {
  scrollTop: number;
  scrollLeft: number;
}

export function CanvasTextEditor({
  value,
  language,
  wordWrap,
  readOnly,
  visible,
  focusRequest,
  initialScrollTop,
  initialScrollLeft,
  onChange,
  onSave,
  onToggleWordWrap,
  onFocusRequestConsumed,
  onScrollPositionCommit,
  onLayoutReady
}: {
  value: string;
  language: ProjectTextLanguageId;
  wordWrap: boolean;
  readOnly?: boolean;
  visible?: boolean | undefined;
  focusRequest?: CanvasTextEditorFocusRequest | undefined;
  initialScrollTop?: number | undefined;
  initialScrollLeft?: number | undefined;
  onChange: (value: string) => void;
  onSave: () => void;
  onToggleWordWrap: () => void;
  onFocusRequestConsumed?: ((requestId: number) => void) | undefined;
  onScrollPositionCommit?: ((position: CanvasTextEditorScrollPosition) => void) | undefined;
  onLayoutReady?: (() => void) | undefined;
}): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const [pointerFocus, setPointerFocus] = React.useState(false);
  const consumedFocusRequestRef = React.useRef<{
    requestId: number;
    view: EditorView;
  } | undefined>(undefined);
  const onLayoutReadyRef = React.useRef(onLayoutReady);
  const onScrollPositionCommitRef = React.useRef(onScrollPositionCommit);
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
    onScrollPositionCommitRef.current = onScrollPositionCommit;
  }, [onScrollPositionCommit]);

  React.useLayoutEffect(() => {
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
    const readScrollPosition = (): CanvasTextEditorScrollPosition => ({
      scrollTop: view.scrollDOM.scrollTop,
      scrollLeft: view.scrollDOM.scrollLeft
    });
    let lastObservedScrollPosition = readScrollPosition();
    let lastCommittedScrollPosition: CanvasTextEditorScrollPosition | undefined;
    let blurred = false;
    const observeScrollPosition = () => {
      if (!blurred) {
        lastObservedScrollPosition = readScrollPosition();
      }
    };
    const commitObservedScrollPosition = () => {
      const position = lastObservedScrollPosition;
      if (lastCommittedScrollPosition
        && lastCommittedScrollPosition.scrollTop === position.scrollTop
        && lastCommittedScrollPosition.scrollLeft === position.scrollLeft) {
        return;
      }
      lastCommittedScrollPosition = position;
      onScrollPositionCommitRef.current?.(position);
    };
    const commitScrollPosition = () => {
      observeScrollPosition();
      blurred = true;
      commitObservedScrollPosition();
    };
    const restoreScrollObservation = () => {
      blurred = false;
      observeScrollPosition();
    };
    view.scrollDOM.addEventListener('scroll', observeScrollPosition);
    host.addEventListener('focusin', restoreScrollObservation);
    host.addEventListener('focusout', commitScrollPosition);

    return () => {
      if (!blurred) {
        observeScrollPosition();
      }
      commitObservedScrollPosition();
      view.scrollDOM.removeEventListener('scroll', observeScrollPosition);
      host.removeEventListener('focusin', restoreScrollObservation);
      host.removeEventListener('focusout', commitScrollPosition);
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
    const request = focusRequest;
    if (!view || !request) {
      return;
    }
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled || viewRef.current !== view) {
        return;
      }
      const consumedFocusRequest = consumedFocusRequestRef.current;
      if (consumedFocusRequest?.requestId === request.requestId && consumedFocusRequest.view === view) {
        return;
      }
      consumedFocusRequestRef.current = {
        requestId: request.requestId,
        view
      };
      canvasTextEditorApplyFocusRequest(view, request);
      setPointerFocus(true);
      onFocusRequestConsumed?.(request.requestId);
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [focusRequest, onFocusRequestConsumed]);

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
      data-pointer-focus={pointerFocus ? 'true' : 'false'}
      className="canvas-text-editor canvas-text-editor--edit"
      style={canvasTextSurfaceCssVariables() as React.CSSProperties}
      onPointerDownCapture={() => setPointerFocus(true)}
    />
  );
}
