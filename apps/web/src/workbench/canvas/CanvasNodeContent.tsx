import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, File, FileText, Folder, Image as ImageIcon, Maximize2, Music2, RefreshCw, Save, Video } from 'lucide-react';
import type { CanvasFeedbackEntry, CanvasFeedbackGeometry, ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { CanvasTextEditor } from './CanvasTextEditor';
import { useCanvasImageNodeAsset, type CanvasImageNodeAssetHookState } from './CanvasImageNodeAssetContext';
import { CanvasImageFeedbackLayer, type CanvasImageFeedbackDraftRegion, type CanvasImageFeedbackMode } from './CanvasImageFeedbackLayer';
import type { CanvasLoadedImage } from './canvasImagePreviews';
import { useCanvasTextPreviewRuntime, type CanvasTextPreviewSource } from './CanvasTextPreviewRuntime';
import { Button, IconButton, StatusPill } from '../ui';

export interface CanvasNodeContentProps {
  node: ProjectedCanvasNode;
  selected: boolean;
  culled: boolean;
  actions: WorkbenchActions;
  textBuffer: TextFileBuffer | undefined;
  textPreview?: CanvasTextPreviewSource | undefined;
  textPreviewError?: string | undefined;
  feedbackEntry?: CanvasFeedbackEntry | undefined;
  localFeedbackMode?: CanvasImageFeedbackMode | undefined;
  pendingFeedbackRegion?: CanvasImageFeedbackDraftRegion | undefined;
  onLocalFeedbackDraft?: ((input: {
    projectRelativePath: string;
    geometry: CanvasFeedbackGeometry;
  }) => void) | undefined;
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
  feedbackEntry,
  localFeedbackMode,
  pendingFeedbackRegion,
  onLocalFeedbackDraft,
  onSelectNode,
  onTitlePointerDown,
  onTitlePointerMove,
  onTitlePointerUp
}: CanvasNodeContentProps): React.ReactElement {
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
    : { title: nodeAvailabilityTitle(node.availability.state), message: node.availability.message };
  const mediaProblem = node.mediaKind === 'image' || !mediaError ? undefined : { title: 'Load Error', message: mediaError };
  const problem = mediaProblem ?? availabilityProblem;
  const retryMediaLoad = () => {
    setMediaError(undefined);
    setMediaRetryNonce((current) => current + 1);
  };

  if (node.nodeKind === 'directory' || node.mediaKind === 'unknown' || !node.mediaKind) {
    return <CanvasGenericNodeContent node={node} problem={problem} />;
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
        onSelectNode={onSelectNode}
        onTitlePointerDown={onTitlePointerDown}
        onTitlePointerMove={onTitlePointerMove}
        onTitlePointerUp={onTitlePointerUp}
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
          ) : node.mediaKind === 'video' ? (
            <video
              key={`${mediaSrc}:${mediaRetryNonce}`}
              controls
              preload="none"
              src={mediaSrc}
              onError={() => setMediaError(`Unable to load ${node.projectRelativePath}.`)}
            />
          ) : (
            <audio
              key={`${mediaSrc}:${mediaRetryNonce}`}
              controls
              preload="none"
              src={mediaSrc}
              onError={() => setMediaError(`Unable to load ${node.projectRelativePath}.`)}
            />
          )}
        </div>
      ) : (
        <div className="canvas-node-preview">
          <div className={problem ? 'db-canvas-node-placeholder db-canvas-node-placeholder--problem' : 'db-canvas-node-placeholder'}>
            {problem ? <AlertTriangle size={22} /> : node.mediaKind === 'video' ? <Video size={22} /> : node.mediaKind === 'audio' ? <Music2 size={22} /> : <ImageIcon size={22} />}
            <strong>{problem?.title ?? (node.mediaKind === 'video' ? 'Video' : node.mediaKind === 'audio' ? 'Audio' : 'Image')}</strong>
            <span>{problem?.message ?? nodeDisplayName(node.projectRelativePath)}</span>
            {mediaProblem ? (
              <Button
                className="db-canvas-node-retry"
                size="xs"
                iconStart={<RefreshCw size={12} />}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={retryMediaLoad}
              >
                Retry
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {node.mediaKind === 'video' || node.mediaKind === 'audio' ? (
        <div className="db-canvas-node-caption">
          <span>{nodeDisplayName(node.projectRelativePath)}</span>
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
  problem
}: {
  node: ProjectedCanvasNode;
  problem: { title: string; message: string } | undefined;
}): React.ReactElement {
  const label = nodeDisplayName(node.projectRelativePath);
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
        Retry
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
  return (
    <div className="db-canvas-node-placeholder">
      <ImageIcon size={22} />
      <strong>Image</strong>
      <span>{nodeDisplayName(node.projectRelativePath)}</span>
      {onRetry ? (
        <Button
          className="db-canvas-node-retry"
          size="xs"
          iconStart={<RefreshCw size={12} />}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onRetry}
        >
          Retry
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
  onSelectNode,
  onTitlePointerDown,
  onTitlePointerMove,
  onTitlePointerUp
}: {
  node: ProjectedCanvasNode;
  buffer: TextFileBuffer | undefined;
  problem: { title: string; message: string } | undefined;
  selected: boolean;
  culled: boolean;
  actions: WorkbenchActions;
  textPreview?: CanvasTextPreviewSource | undefined;
  textPreviewError?: string | undefined;
  onSelectNode: () => void;
  onTitlePointerDown: (event: React.PointerEvent<Element>) => void;
  onTitlePointerMove: (event: React.PointerEvent<Element>) => void;
  onTitlePointerUp: (event: React.PointerEvent<Element>) => void;
}): React.ReactElement {
  const { registerTextBody } = useCanvasTextPreviewRuntime();
  const active = selected;
  const textPreviewProblem = !active && textPreviewError
    ? { title: 'Text Preview Error', message: textPreviewError }
    : undefined;
  const bodyProblem = problem ?? textPreviewProblem;
  const status = textBufferStatus(buffer, bodyProblem);
  const bodyRef = useCallback((element: HTMLDivElement | null) => {
    registerTextBody(node.projectRelativePath, element);
  }, [node.projectRelativePath, registerTextBody]);
  const selectSelf = () => {
    if (!selected) {
      onSelectNode();
    }
  };

  return (
    <section className="canvas-text-node">
      <div
        className="db-canvas-node-titlebar"
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
      >
        <FileText size={13} />
        <strong>{nodeDisplayName(node.projectRelativePath)}</strong>
        {status ? <StatusPill tone={status.tone}>{status.label}</StatusPill> : null}
        <IconButton
          label={`Save ${node.projectRelativePath}`}
          title="Save"
          disabled={!buffer || !buffer.dirty || buffer.saving}
          icon={<Save size={13} />}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void actions.saveTextFileBuffer(node.projectRelativePath)}
        />
        <IconButton
          label={`Open ${node.projectRelativePath} in large editor`}
          title="Open large editor"
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
            <strong>{bodyProblem?.title ?? 'Text Error'}</strong>
            <span>{bodyProblem?.message ?? buffer?.error}</span>
          </div>
        ) : buffer && active ? (
          <CanvasTextEditor
            value={buffer.content}
            language={buffer.language}
            wordWrap={buffer.wordWrap}
            visible={!culled || selected}
            onChange={(content) => actions.updateTextFileBuffer(node.projectRelativePath, content)}
            onSave={() => void actions.saveTextFileBuffer(node.projectRelativePath)}
            onToggleWordWrap={() => actions.toggleTextFileWordWrap(node.projectRelativePath)}
          />
        ) : buffer && textPreview ? (
          <img
            className="canvas-text-preview-image"
            src={textPreview.src}
            alt=""
            draggable={false}
            data-preview-width={textPreview.previewWidth}
          />
        ) : buffer ? (
          <div className="canvas-text-preview-empty" aria-hidden="true" />
        ) : (
          <div className="canvas-text-preview-empty" aria-hidden="true" />
        )}
      </div>
    </section>
  );
}

function textBufferStatus(buffer: TextFileBuffer | undefined, problem: { title: string; message: string } | undefined): { label: string; tone: 'warning' | 'danger' | 'info' | 'loading' } | undefined {
  if (problem || buffer?.error) {
    return { label: 'Error', tone: 'danger' };
  }
  if (!buffer) {
    return { label: 'Loading', tone: 'loading' };
  }
  if (buffer.externalChange) {
    return { label: 'External change', tone: 'info' };
  }
  if (buffer.saving) {
    return { label: 'Saving', tone: 'loading' };
  }
  if (buffer.dirty) {
    return { label: 'Unsaved', tone: 'warning' };
  }
  return undefined;
}

function nodeDisplayName(path: string): string {
  if (path === '') {
    return 'Project Root';
  }
  return path.split('/').pop() ?? path;
}

function nodeAvailabilityTitle(state: ProjectedCanvasNode['availability']['state']): string {
  if (state === 'missing') {
    return 'Missing File';
  }
  return 'Unreadable File';
}
