import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AlertTriangle, File, FileText, Folder, Image as ImageIcon, Maximize2, Music2, RefreshCw, Save } from 'lucide-react';
import type { CanvasFeedbackEntry, CanvasFeedbackGeometry, ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { CanvasTextEditor } from './CanvasTextEditor';
import { CanvasVideoNodeContent } from './CanvasVideoNodeContent';
import type { CanvasVideoPlayerHandle } from './CanvasVideoPlayerAdapter';
import { useCanvasImageNodeAsset, type CanvasImageNodeAssetHookState } from './CanvasImageNodeAssetContext';
import { CanvasImageFeedbackLayer, type CanvasImageFeedbackDraftRegion, type CanvasImageFeedbackMode } from './CanvasImageFeedbackLayer';
import type { CanvasLoadedImage } from './canvasImagePreviews';
import {
  canvasTextPreviewImageReducer,
  initialCanvasTextPreviewImageState,
  useCanvasTextPreviewRuntime,
  type CanvasTextPreviewImageState,
  type CanvasTextPreviewSource
} from './CanvasTextPreviewRuntime';
import type { CanvasTextEditorFocusRequest } from './CanvasTextEditorRuntime';
import type { CanvasVideoPreviewSource } from './canvasVideoPreviews';
import { Button, IconButton, StatusPill } from '../ui';
import { useI18n, type WorkbenchI18n } from '../i18n';

export interface CanvasNodeContentProps {
  node: ProjectedCanvasNode;
  selected: boolean;
  culled: boolean;
  actions: WorkbenchActions;
  textBuffer: TextFileBuffer | undefined;
  textPreview?: CanvasTextPreviewSource | undefined;
  textPreviewError?: string | undefined;
  videoPreview?: CanvasVideoPreviewSource | undefined;
  videoPreviewError?: string | undefined;
  forceVideoPlayerMounted?: boolean | undefined;
  previewInteractionActive?: boolean | undefined;
  feedbackEntry?: CanvasFeedbackEntry | undefined;
  localFeedbackMode?: CanvasImageFeedbackMode | undefined;
  pendingFeedbackRegion?: CanvasImageFeedbackDraftRegion | undefined;
  onLocalFeedbackDraft?: ((input: {
    projectRelativePath: string;
    geometry: CanvasFeedbackGeometry;
  }) => void) | undefined;
  onVideoPlayerMounted: (projectRelativePath: string) => void;
  onVideoPlayingChange: (projectRelativePath: string, playing: boolean) => void;
  onRegisterVideoTarget: (projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined) => void;
  onUpdateVideoPlaybackTime: (projectRelativePath: string, currentTimeSeconds: number) => void | Promise<void>;
  onVideoPreviewError?: ((projectRelativePath: string, preview: CanvasVideoPreviewSource, message: string) => void) | undefined;
  onSelectNode: () => void;
  onTitlePointerDown: (event: React.PointerEvent<Element>) => void;
  onTitlePointerMove: (event: React.PointerEvent<Element>) => void;
  onTitlePointerUp: (event: React.PointerEvent<Element>) => void;
}

export function CanvasNodeContent({
  node,
  selected,
  culled,
  actions,
  textBuffer,
  textPreview,
  textPreviewError,
  videoPreview,
  videoPreviewError,
  forceVideoPlayerMounted = false,
  previewInteractionActive = false,
  feedbackEntry,
  localFeedbackMode,
  pendingFeedbackRegion,
  onLocalFeedbackDraft,
  onVideoPlayerMounted,
  onVideoPlayingChange,
  onRegisterVideoTarget,
  onUpdateVideoPlaybackTime,
  onVideoPreviewError,
  onSelectNode,
  onTitlePointerDown,
  onTitlePointerMove,
  onTitlePointerUp
}: CanvasNodeContentProps): React.ReactElement {
  const i18n = useI18n();
  const [mediaError, setMediaError] = useState<string>();
  const [mediaRetryNonce, setMediaRetryNonce] = useState(0);
  const requestedTextBufferKeyRef = useRef<string | undefined>(undefined);
  const ensureTextFileBufferRef = useRef(actions.ensureTextFileBuffer);
  const nodeRevision = node.availability.state === 'available' ? node.availability.revision : undefined;
  const textBufferEnsureKey = canvasTextBufferEnsureKey(node, textBuffer);
  const mediaSrc = node.mediaKind === 'image'
    ? undefined
    : node.availability.state === 'available'
      ? node.availability.fileUrl
      : undefined;

  ensureTextFileBufferRef.current = actions.ensureTextFileBuffer;

  useEffect(() => {
    setMediaError(undefined);
    setMediaRetryNonce(0);
  }, [mediaSrc, node.mediaKind]);

  useEffect(() => {
    if (!textBufferEnsureKey) {
      requestedTextBufferKeyRef.current = undefined;
      return;
    }
    if (requestedTextBufferKeyRef.current === textBufferEnsureKey) {
      return;
    }
    requestedTextBufferKeyRef.current = textBufferEnsureKey;
    void ensureTextFileBufferRef.current(node.projectRelativePath, nodeRevision);
  }, [
    node.projectRelativePath,
    nodeRevision,
    textBufferEnsureKey
  ]);

  const availabilityProblem = node.availability.state === 'available'
    ? undefined
    : { title: nodeAvailabilityTitle(node.availability.state, i18n), message: node.availability.message };
  const mediaProblem = node.mediaKind === 'image' || !mediaError ? undefined : { title: i18n.t('canvas.node.loadError'), message: mediaError };
  const problem = mediaProblem ?? availabilityProblem;
  const retryMediaLoad = () => {
    setMediaError(undefined);
    setMediaRetryNonce((current) => current + 1);
  };

  if (node.nodeKind === 'directory' || node.mediaKind === 'unknown' || !node.mediaKind) {
    return <CanvasGenericNodeContent node={node} problem={problem} i18n={i18n} />;
  }

  if (node.mediaKind === 'text') {
    return (
      <CanvasTextNodeContent
        node={node}
        buffer={textBuffer}
        problem={problem}
        selected={selected}
        culled={culled}
        actions={actions}
        textPreview={textPreview}
        textPreviewError={textPreviewError}
        previewInteractionActive={previewInteractionActive}
        onSelectNode={onSelectNode}
        onTitlePointerDown={onTitlePointerDown}
        onTitlePointerMove={onTitlePointerMove}
        onTitlePointerUp={onTitlePointerUp}
        i18n={i18n}
      />
    );
  }

  if (node.mediaKind === 'video') {
    return (
      <CanvasVideoNodeContent
        node={node}
        selected={selected}
        videoPreview={videoPreview}
        videoPreviewError={videoPreviewError}
        forcePlayerMounted={forceVideoPlayerMounted}
        onSelectNode={onSelectNode}
        onPlayerMounted={onVideoPlayerMounted}
        onPlayingChange={onVideoPlayingChange}
        onRegisterVideoTarget={onRegisterVideoTarget}
        onUpdatePlaybackTime={onUpdateVideoPlaybackTime}
        onVideoPreviewError={onVideoPreviewError}
      />
    );
  }

  const canRenderMediaPreview = node.availability.state === 'available'
    && (node.mediaKind === 'image' || mediaSrc !== undefined)
    && (!problem || node.mediaKind === 'image');

  return (
    <>
      {canRenderMediaPreview ? (
        <div className="canvas-node-preview">
          {node.mediaKind === 'image' ? (
            <>
              <CanvasImageNodeContent node={node} culled={culled} />
              <CanvasImageFeedbackLayer
                entry={feedbackEntry}
                mode={localFeedbackMode}
                draftRegion={pendingFeedbackRegion}
                onRegionDraft={(geometry) => onLocalFeedbackDraft?.({
                  projectRelativePath: node.projectRelativePath,
                  geometry
                })}
              />
            </>
          ) : (
            <audio
              key={`${mediaSrc}:${mediaRetryNonce}`}
              controls
              preload="none"
              src={mediaSrc}
              onError={() => setMediaError(i18n.t('canvas.node.unableToLoad', { path: node.projectRelativePath }))}
            />
          )}
        </div>
      ) : (
        <div className="canvas-node-preview">
          <div className={problem ? 'db-canvas-node-placeholder db-canvas-node-placeholder--problem' : 'db-canvas-node-placeholder'}>
            {problem ? <AlertTriangle size={22} /> : node.mediaKind === 'audio' ? <Music2 size={22} /> : <ImageIcon size={22} />}
            <strong>{problem?.title ?? mediaKindLabel(node.mediaKind, i18n)}</strong>
            <span>{problem?.message ?? nodeDisplayName(node.projectRelativePath, i18n)}</span>
            {mediaProblem ? (
              <Button
                className="db-canvas-node-retry"
                size="xs"
                iconStart={<RefreshCw size={12} />}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={retryMediaLoad}
              >
                {i18n.t('canvas.node.retry')}
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {node.mediaKind === 'audio' ? (
        <div className="db-canvas-node-caption">
          <span>{nodeDisplayName(node.projectRelativePath, i18n)}</span>
        </div>
      ) : null}
    </>
  );
}

export function canvasTextBufferEnsureKey(
  node: ProjectedCanvasNode,
  textBuffer: TextFileBuffer | undefined
): string | undefined {
  if (node.mediaKind !== 'text' || node.availability.state !== 'available') {
    return undefined;
  }
  if (
    textBuffer
    && textBuffer.projectRelativePath === node.projectRelativePath
    && textBuffer.diskRevision === node.availability.revision
  ) {
    return undefined;
  }
  return `${node.projectRelativePath}\u001f${node.availability.revision}`;
}

function CanvasImageNodeContent({
  node,
  culled
}: {
  node: ProjectedCanvasNode;
  culled: boolean;
}): React.ReactElement {
  const imageState = useCanvasImageNodeAsset({ node, culled });

  return <CanvasImageNodePreview node={node} imageState={imageState} />;
}

export function CanvasImageNodePreview({
  node,
  imageState
}: {
  node: ProjectedCanvasNode;
  imageState: CanvasImageNodeAssetHookState;
}): React.ReactElement {
  const nextImage = imageState.kind === 'image' ? imageState.next : undefined;
  const resolveNextRef = useRef(imageState.resolveNext);
  const rejectNextRef = useRef(imageState.rejectNext);
  resolveNextRef.current = imageState.resolveNext;
  rejectNextRef.current = imageState.rejectNext;
  const resolveLoadedNext = useCallback((loadKey: string) => {
    resolveNextRef.current(loadKey);
  }, []);
  const rejectLoadedNext = useCallback((loadKey: string) => {
    rejectNextRef.current(loadKey);
  }, []);

  useEffect(() => {
    if (!nextImage) {
      return undefined;
    }
    return preloadCanvasImageForHandoff({
      image: nextImage,
      resolveLoaded: resolveLoadedNext,
      rejectLoaded: rejectLoadedNext
    });
  }, [nextImage, rejectLoadedNext, resolveLoadedNext]);

  if (imageState.kind === 'image') {
    return (
      <>
        {imageState.visible ? (
          <img
            key={imageState.visible.loadKey}
            data-canvas-image-layer="visible"
            src={imageState.visible.src}
            alt={node.projectRelativePath}
            draggable={false}
            decoding="async"
            style={{ objectFit: 'fill' }}
          />
        ) : imageState.next ? (
          <div className="canvas-node-image-reserved" aria-hidden="true" />
        ) : (
          <CanvasImagePlaceholder node={node} />
        )}
        {imageState.error ? (
          <CanvasNodeMediaErrorOverlay
            message={imageState.error.message}
            onRetry={imageState.retry}
          />
        ) : null}
      </>
    );
  }

  return (
    <CanvasImagePlaceholder
      node={node}
      onRetry={imageState.kind === 'placeholder' ? imageState.retry : undefined}
    />
  );
}

export function scheduleCanvasImageHandoffAfterPaint(
  callback: () => void,
  scheduler?: {
    requestFrame: (callback: FrameRequestCallback) => number;
    cancelFrame: (handle: number) => void;
  }
): () => void {
  const requestFrame = scheduler?.requestFrame ?? window.requestAnimationFrame.bind(window);
  const cancelFrame = scheduler?.cancelFrame ?? window.cancelAnimationFrame.bind(window);
  let cancelled = false;
  let firstFrame: number | undefined;
  let secondFrame: number | undefined;

  firstFrame = requestFrame(() => {
    firstFrame = undefined;
    if (cancelled) {
      return;
    }
    secondFrame = requestFrame(() => {
      secondFrame = undefined;
      if (!cancelled) {
        callback();
      }
    });
  });

  return () => {
    cancelled = true;
    if (firstFrame !== undefined) {
      cancelFrame(firstFrame);
    }
    if (secondFrame !== undefined) {
      cancelFrame(secondFrame);
    }
  };
}

export function preloadCanvasImageForHandoff(input: {
  image: CanvasLoadedImage;
  resolveLoaded: (loadKey: string) => void;
  rejectLoaded: (loadKey: string) => void;
  createImage?: (() => HTMLImageElement) | undefined;
  scheduler?: Parameters<typeof scheduleCanvasImageHandoffAfterPaint>[1];
}): () => void {
  const image = input.createImage?.() ?? new Image();
  let cancelled = false;
  let settled = false;
  let loadStarted = false;
  let cancelHandoff: (() => void) | undefined;

  const reject = () => {
    if (cancelled || settled) {
      return;
    }
    settled = true;
    input.rejectLoaded(input.image.loadKey);
  };

  const resolveAfterDecode = () => {
    if (cancelled || settled) {
      return;
    }
    settled = true;
    cancelHandoff = scheduleCanvasImageHandoffAfterPaint(() => {
      cancelHandoff = undefined;
      if (!cancelled) {
        input.resolveLoaded(input.image.loadKey);
      }
    }, input.scheduler);
  };

  const load = () => {
    if (cancelled || settled || loadStarted) {
      return;
    }
    loadStarted = true;
    void image.decode().then(resolveAfterDecode, reject);
  };

  image.decoding = 'async';
  image.addEventListener('load', load);
  image.addEventListener('error', reject);
  image.src = input.image.src;

  if (image.complete) {
    if (image.naturalWidth > 0) {
      load();
    } else {
      reject();
    }
  }

  return () => {
    cancelled = true;
    cancelHandoff?.();
    image.removeEventListener('load', load);
    image.removeEventListener('error', reject);
    image.src = '';
  };
}

function CanvasGenericNodeContent({
  node,
  problem,
  i18n
}: {
  node: ProjectedCanvasNode;
  problem: { title: string; message: string } | undefined;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const label = nodeDisplayName(node.projectRelativePath, i18n);
  if (problem) {
    return (
      <div className="db-canvas-node-generic db-canvas-node-generic--problem">
        <AlertTriangle size={20} />
        <strong>{problem.title}</strong>
        <span>{problem.message}</span>
        <span>{label}</span>
      </div>
    );
  }

  return (
    <div className="db-canvas-node-generic">
      {node.nodeKind === 'directory' ? <Folder size={20} /> : <File size={20} />}
      <strong>{label}</strong>
    </div>
  );
}

function CanvasNodeMediaErrorOverlay({
  message,
  onRetry
}: {
  message: string;
  onRetry: () => void;
}): React.ReactElement {
  const i18n = useI18n();
  return (
    <div className="db-canvas-node-error-overlay">
      <AlertTriangle size={16} />
      <span>{message}</span>
      <Button
        className="db-canvas-node-retry"
        size="xs"
        iconStart={<RefreshCw size={12} />}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onRetry}
      >
        {i18n.t('canvas.node.retry')}
      </Button>
    </div>
  );
}

function CanvasImagePlaceholder({
  node,
  onRetry
}: {
  node: ProjectedCanvasNode;
  onRetry?: (() => void) | undefined;
}): React.ReactElement {
  const i18n = useI18n();
  return (
    <div className="db-canvas-node-placeholder">
      <ImageIcon size={22} />
      <strong>{i18n.t('canvas.node.image')}</strong>
      <span>{nodeDisplayName(node.projectRelativePath, i18n)}</span>
      {onRetry ? (
        <Button
          className="db-canvas-node-retry"
          size="xs"
          iconStart={<RefreshCw size={12} />}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onRetry}
        >
          {i18n.t('canvas.node.retry')}
        </Button>
      ) : null}
    </div>
  );
}

function CanvasTextNodeContent({
  node,
  buffer,
  problem,
  selected,
  culled,
  actions,
  textPreview,
  textPreviewError,
  previewInteractionActive,
  onSelectNode,
  onTitlePointerDown,
  onTitlePointerMove,
  onTitlePointerUp,
  i18n
}: {
  node: ProjectedCanvasNode;
  buffer: TextFileBuffer | undefined;
  problem: { title: string; message: string } | undefined;
  selected: boolean;
  culled: boolean;
  actions: WorkbenchActions;
  textPreview?: CanvasTextPreviewSource | undefined;
  textPreviewError?: string | undefined;
  previewInteractionActive: boolean;
  onSelectNode: () => void;
  onTitlePointerDown: (event: React.PointerEvent<Element>) => void;
  onTitlePointerMove: (event: React.PointerEvent<Element>) => void;
  onTitlePointerUp: (event: React.PointerEvent<Element>) => void;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const { registerTextBody } = useCanvasTextPreviewRuntime();
  const active = selected;
  const nextFocusRequestIdRef = useRef(0);
  const [focusRequest, setFocusRequest] = useState<CanvasTextEditorFocusRequest>();
  const [textPreviewVariantError, setTextPreviewVariantError] = useState<string>();
  const textPreviewProblemMessage = textPreviewError ?? textPreviewVariantError;
  const textPreviewProblem = !active && textPreviewProblemMessage
    ? { title: i18n.t('canvas.node.textPreviewError'), message: textPreviewProblemMessage }
    : undefined;
  const bodyProblem = problem ?? textPreviewProblem;
  const status = textBufferStatus(buffer, bodyProblem, i18n);
  const [textPreviewImageState, dispatchTextPreviewImage] = useReducer(
    canvasTextPreviewImageReducer,
    textPreview,
    initialCanvasTextPreviewImageState
  );
  const nextTextPreview = textPreviewImageState.next;
  const bodyRef = useCallback((element: HTMLDivElement | null) => {
    registerTextBody(node.projectRelativePath, element);
  }, [node.projectRelativePath, registerTextBody]);
  const selectSelf = () => {
    if (!selected) {
      onSelectNode();
    }
  };
  const focusRequestForPointerEvent = (event: React.PointerEvent<Element>): CanvasTextEditorFocusRequest | undefined => {
    if (selected || !buffer || bodyProblem || buffer.error) {
      return undefined;
    }
    nextFocusRequestIdRef.current += 1;
    return {
      requestId: nextFocusRequestIdRef.current,
      clientX: event.clientX,
      clientY: event.clientY
    };
  };
  const reportTextPreviewVariantError = useCallback(() => {
    setTextPreviewVariantError(i18n.t('canvas.node.textPreviewVariantLoadError', {
      path: node.projectRelativePath
    }));
  }, [i18n, node.projectRelativePath]);

  useEffect(() => {
    setTextPreviewVariantError(undefined);
  }, [node.projectRelativePath, textPreview?.src]);

  useEffect(() => {
    dispatchTextPreviewImage({ type: 'source-resolved', source: textPreview });
  }, [textPreview]);

  useEffect(() => {
    if (previewInteractionActive) {
      dispatchTextPreviewImage({ type: 'interaction-started' });
    }
  }, [previewInteractionActive]);

  useEffect(() => {
    if (!nextTextPreview) {
      return undefined;
    }
    return preloadCanvasImageForHandoff({
      image: nextTextPreview,
      resolveLoaded: (loadKey) => dispatchTextPreviewImage({ type: 'next-loaded', loadKey }),
      rejectLoaded: (loadKey) => {
        dispatchTextPreviewImage({ type: 'next-failed', loadKey });
        reportTextPreviewVariantError();
      }
    });
  }, [nextTextPreview, reportTextPreviewVariantError]);

  return (
    <section className="canvas-text-node">
      <div
        className="db-canvas-node-titlebar"
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
      >
        <FileText size={13} />
        <strong>{nodeDisplayName(node.projectRelativePath, i18n)}</strong>
        {status ? <StatusPill tone={status.tone}>{status.label}</StatusPill> : null}
        <IconButton
          label={i18n.t('canvas.node.saveFile', { path: node.projectRelativePath })}
          title={i18n.t('canvas.node.save')}
          disabled={!buffer || !buffer.dirty || buffer.saving}
          icon={<Save size={13} />}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void actions.saveTextFileBuffer(node.projectRelativePath)}
        />
        <IconButton
          label={i18n.t('canvas.node.openLargeEditorForFile', { path: node.projectRelativePath })}
          title={i18n.t('canvas.node.openLargeEditor')}
          icon={<Maximize2 size={13} />}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => actions.openTextEditorWindow(node.projectRelativePath)}
        />
      </div>
      <div
        ref={bodyRef}
        className={bodyProblem || buffer?.error ? 'canvas-text-body problem' : 'canvas-text-body'}
        data-canvas-local-wheel="focus"
        onPointerDown={(event) => {
          event.stopPropagation();
          const request = focusRequestForPointerEvent(event);
          setFocusRequest(request);
          selectSelf();
        }}
        onPointerUp={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {bodyProblem || buffer?.error ? (
          <div className="canvas-text-message">
            <AlertTriangle size={18} />
            <strong>{bodyProblem?.title ?? i18n.t('canvas.node.textError')}</strong>
            <span>{bodyProblem?.message ?? buffer?.error}</span>
          </div>
        ) : buffer && active ? (
          <CanvasTextEditor
            value={buffer.content}
            language={buffer.language}
            wordWrap={buffer.wordWrap}
            visible={!culled || selected}
            focusRequest={focusRequest}
            onChange={(content) => actions.updateTextFileBuffer(node.projectRelativePath, content)}
            onSave={() => void actions.saveTextFileBuffer(node.projectRelativePath)}
            onToggleWordWrap={() => actions.toggleTextFileWordWrap(node.projectRelativePath)}
            onFocusRequestConsumed={(requestId) => {
              setFocusRequest((current) => current?.requestId === requestId ? undefined : current);
            }}
          />
        ) : buffer ? (
          <CanvasTextPreviewImage
            state={textPreviewImageState}
            onError={reportTextPreviewVariantError}
          />
        ) : (
          <div className="canvas-text-preview-empty" aria-hidden="true" />
        )}
      </div>
    </section>
  );
}

function CanvasTextPreviewImage({
  state,
  onError
}: {
  state: CanvasTextPreviewImageState;
  onError: () => void;
}): React.ReactElement {
  if (!state.loaded) {
    return <div className="canvas-text-preview-empty" aria-hidden="true" />;
  }

  return (
    <img
      className="canvas-text-preview-image"
      src={state.loaded.src}
      alt=""
      draggable={false}
      data-preview-width={state.loaded.previewWidth}
      onError={onError}
    />
  );
}

function textBufferStatus(
  buffer: TextFileBuffer | undefined,
  problem: { title: string; message: string } | undefined,
  i18n: WorkbenchI18n
): { label: string; tone: 'warning' | 'danger' | 'info' | 'loading' } | undefined {
  if (problem || buffer?.error) {
    return { label: i18n.t('canvas.node.error'), tone: 'danger' };
  }
  if (!buffer) {
    return { label: i18n.t('canvas.node.loading'), tone: 'loading' };
  }
  if (buffer.externalChange) {
    return { label: i18n.t('canvas.node.externalChange'), tone: 'info' };
  }
  if (buffer.saving) {
    return { label: i18n.t('canvas.node.saving'), tone: 'loading' };
  }
  if (buffer.dirty) {
    return { label: i18n.t('canvas.node.unsaved'), tone: 'warning' };
  }
  return undefined;
}

function nodeDisplayName(path: string, i18n: WorkbenchI18n): string {
  if (path === '') {
    return i18n.t('canvas.node.projectRoot');
  }
  return path.split('/').pop() ?? path;
}

function nodeAvailabilityTitle(state: ProjectedCanvasNode['availability']['state'], i18n: WorkbenchI18n): string {
  if (state === 'missing') {
    return i18n.t('canvas.node.missingFile');
  }
  return i18n.t('canvas.node.unreadableFile');
}

function mediaKindLabel(mediaKind: ProjectedCanvasNode['mediaKind'], i18n: WorkbenchI18n): string {
  if (mediaKind === 'video') {
    return i18n.t('canvas.node.video');
  }
  if (mediaKind === 'audio') {
    return i18n.t('canvas.node.audio');
  }
  return i18n.t('canvas.node.image');
}
