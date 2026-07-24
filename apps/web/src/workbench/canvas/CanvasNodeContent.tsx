import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, File, FileText, Folder, Image as ImageIcon, Maximize2, Music2, RefreshCw, Save } from 'lucide-react';
import type { CanvasFeedbackEntry, CanvasFeedbackGeometry, CanvasFeedbackSpatialItem, CanvasTextViewportState, ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { CanvasTextEditor } from './CanvasTextEditor';
import { CanvasVideoNodeContent } from './CanvasVideoNodeContent';
import type { CanvasVideoPlayerHandle } from './CanvasVideoPlayerAdapter';
import { useCanvasImageNodeAsset, type CanvasImageNodeAssetHookState } from './CanvasImageNodeAssetContext';
import { CanvasMediaFeedbackLayer, type CanvasMediaFeedbackDraftRegion, type CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import {
  useCanvasTextPreviewRuntime,
  type CanvasTextPreviewSource
} from './CanvasTextPreviewRuntime';
import { CanvasTextPreviewImageHandoff } from './CanvasTextPreviewImageHandoff';
import type { CanvasTextEditorFocusRequest } from './CanvasTextEditorRuntime';
import type { CanvasVideoPreviewSource } from './canvasVideoPreviews';
import { preloadCanvasImageForHandoff } from './CanvasMediaHandoff';
import { CanvasNodeTitleBar } from './CanvasNodeTitleBar';
import { CanvasNodeErrorPresentation } from './CanvasNodeErrorPresentation';
import { Button, DiscardChangesIcon, IconButton, StatusPill } from '../ui';
import { useI18n, type WorkbenchI18n } from '../i18n';

const FIXED_NODE_PRESENTATION_SCALE = 10;
const GENERIC_NODE_WRAP_VISUAL_HEIGHT = 88;

export interface CanvasNodeContentProps {
  node: ProjectedCanvasNode;
  selected: boolean;
  culled: boolean;
  actions: WorkbenchActions;
  textBuffer: TextFileBuffer | undefined;
  textPreview?: CanvasTextPreviewSource | undefined;
  pendingTextPreview?: CanvasTextPreviewSource | undefined;
  textPreviewCommittedSourceKey?: string | undefined;
  textPreviewError?: string | undefined;
  videoPreview?: CanvasVideoPreviewSource | undefined;
  videoPreviewError?: string | undefined;
  forceVideoPlayerMounted?: boolean | undefined;
  feedbackEntry?: CanvasFeedbackEntry | undefined;
  activeFeedbackItemId?: string | undefined;
  localFeedbackMode?: CanvasMediaFeedbackMode | undefined;
  localFeedbackRegions?: readonly CanvasMediaFeedbackDraftRegion[] | undefined;
  activeFeedbackMomentTimeSeconds?: number | undefined;
  onLocalFeedbackDraft?: ((input: {
    projectRelativePath: string;
    geometry: CanvasFeedbackGeometry;
  }) => void) | undefined;
  onFeedbackItemActivate?: ((projectRelativePath: string, itemId: string) => void) | undefined;
  onVideoPlayerMounted: (projectRelativePath: string) => void;
  onVideoPlayingChange: (projectRelativePath: string, playing: boolean) => void;
  onRegisterVideoTarget: (projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined) => void;
  onUpdateVideoPlaybackTime: (projectRelativePath: string, currentTimeSeconds: number) => void | Promise<void>;
  onUpdateTextViewport: (projectRelativePath: string, viewport: CanvasTextViewportState) => void | Promise<void>;
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
  pendingTextPreview,
  textPreviewCommittedSourceKey,
  textPreviewError,
  videoPreview,
  videoPreviewError,
  forceVideoPlayerMounted = false,
  feedbackEntry,
  activeFeedbackItemId,
  localFeedbackMode,
  localFeedbackRegions,
  activeFeedbackMomentTimeSeconds,
  onLocalFeedbackDraft,
  onFeedbackItemActivate,
  onVideoPlayerMounted,
  onVideoPlayingChange,
  onRegisterVideoTarget,
  onUpdateVideoPlaybackTime,
  onUpdateTextViewport,
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
    void ensureTextFileBufferRef.current(node.projectRelativePath);
  }, [
    node.projectRelativePath,
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
        pendingTextPreview={pendingTextPreview}
        textPreviewCommittedSourceKey={textPreviewCommittedSourceKey}
        textPreviewError={textPreviewError}
        onSelectNode={onSelectNode}
        onTitlePointerDown={onTitlePointerDown}
        onTitlePointerMove={onTitlePointerMove}
        onTitlePointerUp={onTitlePointerUp}
        onUpdateTextViewport={onUpdateTextViewport}
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
        feedbackEntry={feedbackEntry}
        activeFeedbackItemId={activeFeedbackItemId}
        localFeedbackMode={localFeedbackMode}
        localFeedbackRegions={localFeedbackRegions}
        activeFeedbackMomentTimeSeconds={activeFeedbackMomentTimeSeconds}
        onTitlePointerDown={onTitlePointerDown}
        onTitlePointerMove={onTitlePointerMove}
        onTitlePointerUp={onTitlePointerUp}
        onLocalFeedbackDraft={(input) => onLocalFeedbackDraft?.(input)}
        onFeedbackItemActivate={(itemId) => onFeedbackItemActivate?.(node.projectRelativePath, itemId)}
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
              <CanvasMediaFeedbackLayer
                items={imageSpatialFeedbackItems(feedbackEntry)}
                mode={localFeedbackMode}
                draftRegions={localFeedbackRegions}
                activeItemId={activeFeedbackItemId}
                onItemActivate={(itemId) => onFeedbackItemActivate?.(node.projectRelativePath, itemId)}
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

function imageSpatialFeedbackItems(entry: CanvasFeedbackEntry | undefined): CanvasFeedbackSpatialItem[] {
  return entry?.items.filter((item): item is CanvasFeedbackSpatialItem => (
    (item.kind === 'pin' || item.kind === 'region') && item.scope === 'file'
  )) ?? [];
}

export function canvasTextBufferEnsureKey(
  node: ProjectedCanvasNode,
  textBuffer: TextFileBuffer | undefined
): string | undefined {
  if (node.mediaKind !== 'text' || node.availability.state !== 'available') {
    return undefined;
  }
  if (textBuffer?.projectRelativePath === node.projectRelativePath) {
    return undefined;
  }
  return node.projectRelativePath;
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
            data-preview-width={imageState.visible.previewWidth}
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
          <CanvasNodeErrorPresentation
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
  const className = [
    'db-canvas-node-generic',
    problem ? 'db-canvas-node-generic--problem' : '',
    genericNodeAllowsLabelWrap(node) ? 'db-canvas-node-generic--wrap' : ''
  ].filter(Boolean).join(' ');
  if (problem) {
    return (
      <div className={className}>
        <AlertTriangle size={20} />
        <strong>{problem.title}</strong>
        <span>{problem.message}</span>
        <span className="db-canvas-node-generic__label">{label}</span>
      </div>
    );
  }

  return (
    <div className={className}>
      {node.nodeKind === 'directory' ? <Folder size={20} /> : <File size={20} />}
      <strong className="db-canvas-node-generic__label">{label}</strong>
    </div>
  );
}

function genericNodeAllowsLabelWrap(node: Pick<ProjectedCanvasNode, 'height'>): boolean {
  return node.height / FIXED_NODE_PRESENTATION_SCALE >= GENERIC_NODE_WRAP_VISUAL_HEIGHT;
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
  pendingTextPreview,
  textPreviewCommittedSourceKey,
  textPreviewError,
  onSelectNode,
  onTitlePointerDown,
  onTitlePointerMove,
  onTitlePointerUp,
  onUpdateTextViewport,
  i18n
}: {
  node: ProjectedCanvasNode;
  buffer: TextFileBuffer | undefined;
  problem: { title: string; message: string } | undefined;
  selected: boolean;
  culled: boolean;
  actions: WorkbenchActions;
  textPreview?: CanvasTextPreviewSource | undefined;
  pendingTextPreview?: CanvasTextPreviewSource | undefined;
  textPreviewCommittedSourceKey?: string | undefined;
  textPreviewError?: string | undefined;
  onSelectNode: () => void;
  onTitlePointerDown: (event: React.PointerEvent<Element>) => void;
  onTitlePointerMove: (event: React.PointerEvent<Element>) => void;
  onTitlePointerUp: (event: React.PointerEvent<Element>) => void;
  onUpdateTextViewport: (projectRelativePath: string, viewport: CanvasTextViewportState) => void | Promise<void>;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const {
    registerTextBody,
    reportPendingReady,
    reportPendingFailure,
    reportVisibleFailure,
    reportVisibleCommitted
  } = useCanvasTextPreviewRuntime();
  const active = selected;
  const [visibleTextLayer, setVisibleTextLayer] = useState<'editor' | 'preview'>(() => active ? 'editor' : 'preview');
  const [handoffViewport, setHandoffViewport] = useState<CanvasTextViewportState>();
  const nextFocusRequestIdRef = useRef(0);
  const [focusRequest, setFocusRequest] = useState<CanvasTextEditorFocusRequest>();
  const currentViewport = node.textViewport ?? { scrollTop: 0, scrollLeft: 0 };
  const handoffViewportIsCurrent = handoffViewport !== undefined
    && handoffViewport.scrollTop === currentViewport.scrollTop
    && handoffViewport.scrollLeft === currentViewport.scrollLeft;
  const previewHandoffReady = handoffViewportIsCurrent
    && (textPreviewError
      || (textPreview !== undefined && textPreview.sourceKey === textPreviewCommittedSourceKey));
  const textPreviewProblem = !active && textPreviewError
    ? { title: i18n.t('canvas.node.textPreviewError'), message: textPreviewError }
    : undefined;
  const textPreviewBlockingProblem = textPreview ? undefined : textPreviewProblem;
  const textPreviewOverlayProblem = textPreview ? textPreviewProblem : undefined;
  const bodyProblem = problem ?? (visibleTextLayer === 'preview' ? textPreviewBlockingProblem : undefined);
  const status = textBufferStatus(buffer, problem ?? textPreviewProblem, i18n);
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
  const commitTextViewport = useCallback((viewport: CanvasTextViewportState) => {
    const current = node.textViewport ?? { scrollTop: 0, scrollLeft: 0 };
    if (current.scrollTop === viewport.scrollTop && current.scrollLeft === viewport.scrollLeft) {
      return;
    }
    void onUpdateTextViewport(node.projectRelativePath, viewport);
  }, [
    node.projectRelativePath,
    node.textViewport,
    onUpdateTextViewport
  ]);

  useEffect(() => {
    if (active) {
      setVisibleTextLayer('editor');
      setHandoffViewport(undefined);
    }
  }, [active]);

  useEffect(() => {
    if (!active
      && visibleTextLayer === 'editor'
      && previewHandoffReady) {
      setVisibleTextLayer('preview');
    }
  }, [
    active,
    previewHandoffReady,
    visibleTextLayer
  ]);

  const showTextEditor = Boolean(buffer && (active || visibleTextLayer === 'editor'));
  const showTextPreviewHandoff = !active || textPreview !== undefined;
  const textPreviewHidden = active || (visibleTextLayer === 'editor' && !previewHandoffReady);

  return (
    <section className="canvas-text-node">
      <CanvasNodeTitleBar
        icon={<FileText size={13} />}
        title={nodeDisplayName(node.projectRelativePath, i18n)}
        status={status ? <StatusPill tone={status.tone}>{status.label}</StatusPill> : null}
        actions={(
          <>
            <IconButton
              label={i18n.t('canvas.node.saveFile', { path: node.projectRelativePath })}
              title={i18n.t('canvas.node.save')}
              disabled={!buffer || !buffer.dirty || buffer.saving}
              icon={<Save size={13} />}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => void actions.saveTextFileBuffer(node.projectRelativePath)}
            />
            <IconButton
              label={i18n.t('canvas.node.discardFileChanges', { path: node.projectRelativePath })}
              title={i18n.t('canvas.node.discardChanges')}
              variant="danger"
              disabled={!buffer || !buffer.dirty || buffer.saving}
              icon={<DiscardChangesIcon size={13} />}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => void actions.discardTextFileBuffer(node.projectRelativePath)}
            />
            <IconButton
              label={i18n.t('canvas.node.openLargeEditorForFile', { path: node.projectRelativePath })}
              title={i18n.t('canvas.node.openLargeEditor')}
              icon={<Maximize2 size={13} />}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => actions.openTextEditorWindow(node.projectRelativePath)}
            />
          </>
        )}
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
      />
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
        ) : buffer ? (
          <>
            {showTextEditor ? (
              <CanvasTextEditor
                value={buffer.content}
                language={buffer.language}
                wordWrap={buffer.wordWrap}
                readOnly={!active}
                visible={!culled || selected}
                focusRequest={active ? focusRequest : undefined}
                initialScrollTop={node.textViewport?.scrollTop}
                initialScrollLeft={node.textViewport?.scrollLeft}
                onChange={(content) => actions.updateTextFileBuffer(node.projectRelativePath, content)}
                onSave={() => void actions.saveTextFileBuffer(node.projectRelativePath)}
                onToggleWordWrap={() => actions.toggleTextFileWordWrap(node.projectRelativePath)}
                onScrollPositionCommit={commitTextViewport}
                onReadOnlyTransition={setHandoffViewport}
                onFocusRequestConsumed={(requestId) => {
                  setFocusRequest((current) => current?.requestId === requestId ? undefined : current);
                }}
              />
            ) : null}
            {showTextPreviewHandoff ? (
              <CanvasTextPreviewImageHandoff
                presentation={{ visible: textPreview, pending: pendingTextPreview }}
                hidden={textPreviewHidden}
                onPendingReady={(source) => reportPendingReady(node, source)}
                onPendingFailure={(source, error, kind) => reportPendingFailure(node, source, error, kind)}
                onVisibleFailure={(source, error, kind) => reportVisibleFailure(node, source, error, kind)}
                onVisibleCommitted={(source) => reportVisibleCommitted(node, source)}
              />
            ) : null}
            {!showTextEditor && textPreviewOverlayProblem ? (
              <div className="canvas-text-message canvas-text-message--overlay">
                <AlertTriangle size={18} />
                <strong>{textPreviewOverlayProblem.title}</strong>
                <span>{textPreviewOverlayProblem.message}</span>
              </div>
            ) : null}
          </>
        ) : (
          <div className="canvas-text-preview-empty" aria-hidden="true" />
        )}
      </div>
    </section>
  );
}

function textBufferStatus(
  buffer: TextFileBuffer | undefined,
  problem: { title: string; message: string } | undefined,
  i18n: WorkbenchI18n
): { label: string; tone: 'danger' | 'info' | 'loading' } | undefined {
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
