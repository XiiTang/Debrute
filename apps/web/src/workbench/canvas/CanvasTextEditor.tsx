import React from 'react';
import type { ProjectTextLanguageId } from '@debrute/app-protocol';
import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { loadCodeMirrorLanguageExtensionForProjectTextLanguage } from './textEditorCodeMirrorLanguages.js';
import { useCanvasTextRenderProfile } from './CanvasTextRenderProfileContext.js';
import {
  canvasTextEditorApplyFocusRequest,
  canvasTextEditorApplyInitialScroll,
  canvasTextEditorBaseExtensions,
  canvasTextEditorEnsureVisibleSyntaxReady,
  canvasTextEditorCursorScrollMarginExtension,
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
  renderProfile: Compartment;
  wordWrap: Compartment;
}

export interface CanvasTextEditorScrollPosition {
  scrollTop: number;
  scrollLeft: number;
}

export interface CanvasTextEditorProps {
  value: string;
  language: ProjectTextLanguageId;
  wordWrap: boolean;
  readOnly?: boolean;
  visible?: boolean | undefined;
  published?: boolean | undefined;
  focusRequest?: CanvasTextEditorFocusRequest | undefined;
  initialScrollTop?: number | undefined;
  initialScrollLeft?: number | undefined;
  onChange: (value: string) => void;
  onSave: () => void;
  onToggleWordWrap: () => void;
  onFocusRequestConsumed?: ((requestId: number) => void) | undefined;
  onScrollPositionCommit?: ((position: CanvasTextEditorScrollPosition) => void) | undefined;
  onReadOnlyTransition?: ((position: CanvasTextEditorScrollPosition) => void) | undefined;
  onLayoutReady?: (() => void) | undefined;
  onLayoutFailure?: ((error: Error) => void) | undefined;
  fontPurpose?: 'interactive' | 'preview' | undefined;
}

export function CanvasTextEditor({
  value,
  language,
  wordWrap,
  readOnly,
  visible,
  published = true,
  focusRequest,
  initialScrollTop,
  initialScrollLeft,
  onChange,
  onSave,
  onToggleWordWrap,
  onFocusRequestConsumed,
  onScrollPositionCommit,
  onReadOnlyTransition,
  onLayoutReady,
  onLayoutFailure,
  fontPurpose = 'interactive'
}: CanvasTextEditorProps): React.ReactElement {
  const renderProfile = useCanvasTextRenderProfile();
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const [pointerFocus, setPointerFocus] = React.useState(false);
  const [readyLanguage, setReadyLanguage] = React.useState<ProjectTextLanguageId>();
  const consumedFocusRequestRef = React.useRef<{
    requestId: number;
    view: EditorView;
  } | undefined>(undefined);
  const onLayoutReadyRef = React.useRef(onLayoutReady);
  const onLayoutFailureRef = React.useRef(onLayoutFailure);
  const onFocusRequestConsumedRef = React.useRef(onFocusRequestConsumed);
  const onScrollPositionCommitRef = React.useRef(onScrollPositionCommit);
  const layoutFailedRef = React.useRef(false);
  const commitObservedScrollPositionRef = React.useRef<(
    () => CanvasTextEditorScrollPosition
  ) | undefined>(undefined);
  const previousReadOnlyRef = React.useRef(Boolean(readOnly));
  const previousPublishedRef = React.useRef(published);
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
      renderProfile: new Compartment(),
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
    onLayoutReadyRef.current = onLayoutReady;
  }, [onLayoutReady]);

  React.useEffect(() => {
    onLayoutFailureRef.current = onLayoutFailure;
  }, [onLayoutFailure]);

  const reportLayoutFailure = React.useCallback((reason: unknown) => {
    if (layoutFailedRef.current) {
      return;
    }
    layoutFailedRef.current = true;
    onLayoutFailureRef.current?.(errorFromUnknown(reason));
  }, []);

  onFocusRequestConsumedRef.current = onFocusRequestConsumed;

  const applyFocusRequest = React.useCallback((
    view: EditorView,
    request: CanvasTextEditorFocusRequest
  ) => {
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
    onFocusRequestConsumedRef.current?.(request.requestId);
  }, []);

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
        compartments.language.of([]),
        compartments.readOnly.of(canvasTextEditorReadOnlyExtension(readOnly)),
        compartments.renderProfile.of(canvasTextEditorCursorScrollMarginExtension(renderProfile)),
        compartments.wordWrap.of(canvasTextEditorWordWrapExtension(wordWrap))
      ],
      parent: host
    });
    viewRef.current = view;
    const initialScrollPosition = {
      scrollTop: initialScrollTop,
      scrollLeft: initialScrollLeft
    };
    try {
      canvasTextEditorApplyInitialScroll(view, {
        scrollTop: initialScrollPosition.scrollTop,
        scrollLeft: initialScrollPosition.scrollLeft
      });
    } catch (reason) {
      layoutFailedRef.current = true;
      view.destroy();
      viewRef.current = null;
      throw reason;
    }
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
        return position;
      }
      lastCommittedScrollPosition = position;
      onScrollPositionCommitRef.current?.(position);
      return position;
    };
    commitObservedScrollPositionRef.current = commitObservedScrollPosition;
    const commitScrollPosition = () => {
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
    let initialScrollFrame: number | undefined;
    if ((initialScrollPosition.scrollTop ?? 0) !== 0 || (initialScrollPosition.scrollLeft ?? 0) !== 0) {
      initialScrollFrame = window.requestAnimationFrame(() => {
        initialScrollFrame = undefined;
        try {
          canvasTextEditorApplyInitialScroll(view, {
            scrollTop: initialScrollPosition.scrollTop,
            scrollLeft: initialScrollPosition.scrollLeft
          });
          observeScrollPosition();
        } catch (reason) {
          reportLayoutFailure(reason);
        }
      });
    }

    return () => {
      if (initialScrollFrame !== undefined) {
        window.cancelAnimationFrame(initialScrollFrame);
      }
      commitObservedScrollPosition();
      view.scrollDOM.removeEventListener('scroll', observeScrollPosition);
      host.removeEventListener('focusin', restoreScrollObservation);
      host.removeEventListener('focusout', commitScrollPosition);
      commitObservedScrollPositionRef.current = undefined;
      view.destroy();
      viewRef.current = null;
    };
  }, [reportLayoutFailure]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || visible === false || readyLanguage !== language) {
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
    const notifyWhenSyntaxReady = () => {
      if (cancelled || layoutFailedRef.current) {
        return;
      }
      try {
        if (!canvasTextEditorEnsureVisibleSyntaxReady(view)) {
          scheduleFrame(notifyWhenSyntaxReady);
          return;
        }
        onLayoutReadyRef.current?.();
      } catch (reason) {
        reportLayoutFailure(reason);
      }
    };
    if ((initialScrollTop ?? 0) === 0 && (initialScrollLeft ?? 0) === 0) {
      queueMicrotask(notifyWhenSyntaxReady);
    } else {
      view.requestMeasure({
        read: () => undefined,
        write: () => {
          queueMicrotask(notifyWhenSyntaxReady);
        }
      });
    }
    return () => {
      cancelled = true;
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [initialScrollLeft, initialScrollTop, language, readyLanguage, reportLayoutFailure, visible]);

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
    if (!view || !request || !published) {
      return;
    }
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled || viewRef.current !== view) {
        return;
      }
      try {
        applyFocusRequest(view, request);
      } catch (reason) {
        reportLayoutFailure(reason);
      }
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [applyFocusRequest, focusRequest, published, reportLayoutFailure]);

  React.useLayoutEffect(() => {
    const wasPublished = previousPublishedRef.current;
    previousPublishedRef.current = published;
    const view = viewRef.current;
    if (!wasPublished && published && view && focusRequest) {
      try {
        applyFocusRequest(view, focusRequest);
      } catch (reason) {
        reportLayoutFailure(reason);
      }
    }
  }, [applyFocusRequest, focusRequest, published, reportLayoutFailure]);

  React.useEffect(() => {
    const view = viewRef.current;
    const compartments = compartmentsRef.current;
    if (!view || !compartments) {
      return;
    }
    let cancelled = false;
    setReadyLanguage(undefined);
    void loadCodeMirrorLanguageExtensionForProjectTextLanguage(language).then(
      (extension) => {
        if (cancelled || viewRef.current !== view) {
          return;
        }
        try {
          view.dispatch({ effects: compartments.language.reconfigure(extension) });
          setReadyLanguage(language);
        } catch (reason) {
          reportLayoutFailure(reason);
        }
      },
      (reason: unknown) => {
        if (!cancelled && viewRef.current === view) {
          reportLayoutFailure(reason);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [language, reportLayoutFailure]);

  React.useEffect(() => {
    const view = viewRef.current;
    const compartments = compartmentsRef.current;
    if (!view || !compartments) {
      return;
    }
    view.dispatch({
      effects: [
        compartments.readOnly.reconfigure(canvasTextEditorReadOnlyExtension(readOnly)),
        compartments.renderProfile.reconfigure(canvasTextEditorCursorScrollMarginExtension(renderProfile)),
        compartments.wordWrap.reconfigure(canvasTextEditorWordWrapExtension(wordWrap))
      ]
    });
  }, [readOnly, renderProfile, wordWrap]);

  React.useLayoutEffect(() => {
    const wasReadOnly = previousReadOnlyRef.current;
    const nextReadOnly = Boolean(readOnly);
    previousReadOnlyRef.current = nextReadOnly;
    if (!wasReadOnly && nextReadOnly) {
      setPointerFocus(false);
      viewRef.current?.contentDOM.blur();
      const position = commitObservedScrollPositionRef.current?.();
      if (position) {
        onReadOnlyTransition?.(position);
      }
    }
  }, [onReadOnlyTransition, readOnly]);

  return (
    <div
      ref={hostRef}
      data-canvas-text-editor="true"
      data-editor-engine="codemirror"
      data-editor-mode={readOnly ? 'handoff' : 'edit'}
      data-editor-published={published ? 'true' : 'false'}
      data-word-wrap={wordWrap ? 'on' : 'off'}
      data-pointer-focus={!readOnly && pointerFocus ? 'true' : 'false'}
      inert={!published}
      className={`canvas-text-editor canvas-text-editor--${readOnly ? 'handoff' : 'edit'}`}
      style={(fontPurpose === 'preview'
        ? renderProfile.previewEditorStyle
        : renderProfile.editorStyle) as React.CSSProperties}
      onPointerDownCapture={() => {
        if (!readOnly) {
          setPointerFocus(true);
        }
      }}
    />
  );
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
