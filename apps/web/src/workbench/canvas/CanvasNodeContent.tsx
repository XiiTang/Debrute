import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, File, FileText, Folder, Image as ImageIcon, Maximize2, Music2, RefreshCw, Save } from '../ui/index.js';
import type { CanvasFeedbackEntry, CanvasFeedbackGeometry, CanvasFeedbackSpatialItem, CanvasTextViewportState } from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from './CanvasScene.js';
import type { TextFileBuffer } from '../../types';
import { CanvasVideoNodeContent } from './CanvasVideoNodeContent';
import type { CanvasVideoPlayerHandle } from './CanvasVideoPlayerAdapter';
import type { CanvasPreviewActivationRequest } from './CanvasDomInteractionAdapter.js';
import type { CanvasSceneActions } from './CanvasSceneActions.js';
import { canvasImageRasterPreviewRequestForNode } from './canvasImagePreviewTarget';
import { CanvasMediaFeedbackLayer, type CanvasMediaFeedbackDraftRegion, type CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import { useCanvasTextPreviewRuntime } from './CanvasTextPreviewRuntime';
import type { CanvasTextEditorFocusRequest } from './CanvasTextEditorRuntime';
import {
  useCanvasRasterPreviewPresentation,
  type CanvasRasterPreviewRequest
} from './CanvasRasterPreviewPresentation';
import { CanvasNodeTitleBar } from './CanvasNodeTitleBar';
import { CanvasNodeErrorPresentation } from './CanvasNodeErrorPresentation';
import { Button, DiscardChangesIcon, IconButton, StatusPill } from '../ui/index.js';
import { useI18n, type WorkbenchI18n } from '../i18n';
import { workbenchStartupTimeline } from '../../startup/workbenchStartupTimeline.js';
import {
  CanvasTextRenderProfileGate,
  useCanvasTextRenderProfile
} from './CanvasTextRenderProfileContext.js';
import {
  CANVAS_NODE_PRESENTATION_SCALE,
  canvasTextPresentationGeometry
} from './CanvasTextPresentationGeometry.js';

const GENERIC_NODE_WRAP_VISUAL_HEIGHT = 88;
const CanvasTextEditor = React.lazy(async () => {
  workbenchStartupTimeline.markFeatureRequested('text-editor');
  const module = await import('./CanvasTextEditor.js');
  workbenchStartupTimeline.markFeatureReady('text-editor');
  return { default: module.CanvasTextEditor };
});

class CanvasTextEditorActivationBoundary extends React.Component<{
  children: React.ReactNode;
  onError: (error: Error) => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(errorFromUnknown(error));
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export interface CanvasNodeContentProps {
  node: ProjectedCanvasNode;
  contentInteractionActive: boolean;
  actions: CanvasSceneActions;
  textBuffer: TextFileBuffer | undefined;
  textPreviewRequest?: CanvasRasterPreviewRequest | undefined;
  textPreviewError?: string | undefined;
  videoPreviewRequest?: CanvasRasterPreviewRequest | undefined;
  videoPreviewError?: string | undefined;
  forceVideoPlayerMounted?: boolean | undefined;
  previewActivationRequest?: CanvasPreviewActivationRequest | undefined;
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
  onUpdateVideoPlaybackTime: (projectRelativePath: string, currentTimeMs: number) => void | Promise<void>;
  onUpdateTextViewport: (projectRelativePath: string, viewport: CanvasTextViewportState) => void | Promise<void>;
}

export function CanvasNodeContent({
  node,
  contentInteractionActive,
  actions,
  textBuffer,
  textPreviewRequest,
  textPreviewError,
  videoPreviewRequest,
  videoPreviewError,
  forceVideoPlayerMounted = false,
  previewActivationRequest,
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
  onUpdateTextViewport
}: CanvasNodeContentProps): React.ReactElement {
  const i18n = useI18n();
  const [mediaError, setMediaError] = useState<string>();
  const [mediaRetryNonce, setMediaRetryNonce] = useState(0);
  const requestedTextBufferKeyRef = useRef<string | undefined>(undefined);
  const ensureTextFileBufferRef = useRef(actions.ensureTextFileBuffer);
  const textBufferEnsureKey = canvasTextBufferEnsureKey(
    node,
    textBuffer,
    contentInteractionActive
  );
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

  const availabilityProblem = node.availability.state === 'available' || node.availability.state === 'directory'
    ? undefined
    : { title: nodeAvailabilityTitle(node.availability.state, i18n), message: node.availability.message };
  const mediaProblem = node.mediaKind === 'image' || !mediaError ? undefined : { title: i18n.t('canvas.node.loadError'), message: mediaError };
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
        active={contentInteractionActive}
        actions={actions}
        textPreviewRequest={textPreviewRequest}
        textPreviewError={textPreviewError}
        previewActivationRequest={previewActivationRequest}
        onUpdateTextViewport={onUpdateTextViewport}
        i18n={i18n}
      />
    );
  }

  if (node.mediaKind === 'video') {
    return (
      <CanvasVideoNodeContent
        node={node}
        contentInteractionActive={contentInteractionActive}
        videoPreviewRequest={videoPreviewRequest}
        videoPreviewError={videoPreviewError}
        forcePlayerMounted={forceVideoPlayerMounted}
        previewActivationRequest={previewActivationRequest}
        onPlayerMounted={onVideoPlayerMounted}
        onPlayingChange={onVideoPlayingChange}
        onRegisterVideoTarget={onRegisterVideoTarget}
        onUpdatePlaybackTime={onUpdateVideoPlaybackTime}
        feedbackEntry={feedbackEntry}
        activeFeedbackItemId={activeFeedbackItemId}
        localFeedbackMode={localFeedbackMode}
        localFeedbackRegions={localFeedbackRegions}
        activeFeedbackMomentTimeSeconds={activeFeedbackMomentTimeSeconds}
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
        <div
          className="canvas-node-preview"
          data-canvas-node-zone={node.mediaKind === 'audio' ? contentInteractionActive ? 'passive' : 'activate' : undefined}
        >
          {node.mediaKind === 'image' ? (
            <>
              <CanvasImageNodeContent node={node} />
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
              inert={!contentInteractionActive}
              data-canvas-interaction-island={contentInteractionActive ? 'true' : undefined}
              onError={() => setMediaError(i18n.t('canvas.node.unableToLoad', { path: node.projectRelativePath }))}
            />
          )}
        </div>
      ) : (
        <div className="canvas-node-preview">
          <div className={problem ? 'db-canvas-node-placeholder db-canvas-node-placeholder--problem' : 'db-canvas-node-placeholder'}>
            {problem ? <AlertTriangle size={22} /> : node.mediaKind === 'audio' ? <Music2 size={22} /> : <ImageIcon size={22} />}
            <strong>{problem?.title ?? mediaKindLabel(node.mediaKind, i18n)}</strong>
            <span>{problem?.message ?? nodeDisplayName(node)}</span>
            {mediaProblem ? (
              <Button
                className="db-canvas-node-retry"
                size="xs"
                iconStart={<RefreshCw size={12} />}
                onClick={retryMediaLoad}
              >
                {i18n.t('canvas.node.retry')}
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {node.mediaKind === 'audio' ? (
        <div className="db-canvas-node-caption" data-canvas-node-zone="move">
          <span>{nodeDisplayName(node)}</span>
        </div>
      ) : null}
    </>
  );
}

function imageSpatialFeedbackItems(entry: CanvasFeedbackEntry | undefined): CanvasFeedbackSpatialItem[] {
  return entry?.items.filter((item): item is CanvasFeedbackSpatialItem => (
    (item.kind === 'pin' || item.kind === 'region') && item.scope === 'node'
  )) ?? [];
}

export function canvasTextBufferEnsureKey(
  node: ProjectedCanvasNode,
  textBuffer: TextFileBuffer | undefined,
  contentRequested: boolean
): string | undefined {
  if (!contentRequested
    || node.mediaKind !== 'text'
    || node.availability.state !== 'available') {
    return undefined;
  }
  if (textBuffer?.projectRelativePath === node.projectRelativePath) {
    return undefined;
  }
  return node.projectRelativePath;
}

function CanvasImageNodeContent({
  node
}: {
  node: ProjectedCanvasNode;
}): React.ReactElement {
  const request = React.useMemo(() => canvasImageRasterPreviewRequestForNode(node), [node]);
  const presentation = useCanvasRasterPreviewPresentation({
    request,
    nodeDisplayWidth: node.width,
    fit: 'fill'
  });

  return (
    <>
      {presentation.layers}
      {!presentation.hasVisible && presentation.status !== 'failed' ? (
        request.variantTarget
          ? <div className="canvas-node-image-reserved" aria-hidden="true" />
          : <CanvasImagePlaceholder node={node} />
      ) : null}
      {presentation.failure ? (
        <CanvasNodeErrorPresentation
          message={`Unable to load ${node.projectRelativePath}.`}
          onRetry={presentation.retry}
        />
      ) : null}
    </>
  );
}

function CanvasGenericNodeContent({
  node,
  problem
}: {
  node: ProjectedCanvasNode;
  problem: { title: string; message: string } | undefined;
}): React.ReactElement {
  const label = nodeDisplayName(node);
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
  return node.height / CANVAS_NODE_PRESENTATION_SCALE >= GENERIC_NODE_WRAP_VISUAL_HEIGHT;
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
      <span>{nodeDisplayName(node)}</span>
      {onRetry ? (
        <Button
          className="db-canvas-node-retry"
          size="xs"
          iconStart={<RefreshCw size={12} />}
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
  active,
  actions,
  textPreviewRequest,
  textPreviewError,
  previewActivationRequest,
  onUpdateTextViewport,
  i18n
}: {
  node: ProjectedCanvasNode;
  buffer: TextFileBuffer | undefined;
  problem: { title: string; message: string } | undefined;
  active: boolean;
  actions: CanvasSceneActions;
  textPreviewRequest?: CanvasRasterPreviewRequest | undefined;
  textPreviewError?: string | undefined;
  previewActivationRequest?: CanvasPreviewActivationRequest | undefined;
  onUpdateTextViewport: (projectRelativePath: string, viewport: CanvasTextViewportState) => void | Promise<void>;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const textRenderProfile = useCanvasTextRenderProfile();
  const { retryPreview } = useCanvasTextPreviewRuntime();
  const retryTextPreviewSource = useCallback(() => {
    retryPreview(node.projectRelativePath);
  }, [node.projectRelativePath, retryPreview]);
  const activeRef = useRef(active);
  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);
  const [visibleTextLayer, setVisibleTextLayer] = useState<'editor' | 'preview'>('preview');
  const [handoffViewport, setHandoffViewport] = useState<CanvasTextViewportState>();
  const [editorActivationError, setEditorActivationError] = useState<Error>();
  const lastActivationRequestIdRef = useRef<number | undefined>(undefined);
  const [focusRequest, setFocusRequest] = useState<CanvasTextEditorFocusRequest>();
  const textRasterPreview = useCanvasRasterPreviewPresentation({
    request: textPreviewRequest ?? {},
    nodeDisplayWidth: node.width,
    fit: 'fill',
    hidden: visibleTextLayer === 'editor',
    trackDomCommit: true,
    sourceFailure: textPreviewError
      ? { stage: 'source', error: new Error(textPreviewError), retry: retryTextPreviewSource }
      : undefined
  });
  const retryCurrentTextPreview = textRasterPreview.retry;
  const currentTextPreviewError = textRasterPreview.failure
    ? errorFromUnknown(textRasterPreview.failure.error).message
    : undefined;
  const currentViewport = node.textViewport ?? { scrollTop: 0, scrollLeft: 0 };
  const handoffViewportIsCurrent = handoffViewport !== undefined
    && handoffViewport.scrollTop === currentViewport.scrollTop
    && handoffViewport.scrollLeft === currentViewport.scrollLeft;
  const previewHandoffReady = handoffViewportIsCurrent
    && (currentTextPreviewError
      || (textRasterPreview.hasVisible
        && textRasterPreview.visibleSourceKey === textRasterPreview.committedSourceKey));
  const textPreviewProblem = !active && currentTextPreviewError
    ? { title: i18n.t('canvas.node.textPreviewError'), message: currentTextPreviewError }
    : undefined;
  const textPreviewBlockingProblem = textRasterPreview.hasVisible ? undefined : textPreviewProblem;
  const textPreviewOverlayProblem = textRasterPreview.hasVisible ? textPreviewProblem : undefined;
  const editorActivationProblem = active
    && (buffer?.error !== undefined || editorActivationError !== undefined)
    ? {
        title: i18n.t('canvas.node.textError'),
        message: buffer?.error ?? editorActivationError?.message ?? i18n.t('canvas.node.textError')
      }
    : undefined;
  const editorActivationBlockingProblem = textRasterPreview.hasVisible ? undefined : editorActivationProblem;
  const editorActivationOverlayProblem = textRasterPreview.hasVisible ? editorActivationProblem : undefined;
  const bodyProblem = problem
    ?? editorActivationBlockingProblem
    ?? (visibleTextLayer === 'preview' ? textPreviewBlockingProblem : undefined);
  const overlayProblem = editorActivationOverlayProblem ?? textPreviewOverlayProblem;
  const status = textBufferStatus(buffer, problem ?? editorActivationProblem ?? textPreviewProblem, active, i18n);
  useEffect(() => {
    if (
      previewActivationRequest?.mediaKind !== 'text'
      || previewActivationRequest.projectRelativePath !== node.projectRelativePath
      || !active
      || bodyProblem
      || buffer?.error
      || lastActivationRequestIdRef.current === previewActivationRequest.requestId
    ) {
      return;
    }
    lastActivationRequestIdRef.current = previewActivationRequest.requestId;
    setFocusRequest({
      requestId: previewActivationRequest.requestId,
      clientX: previewActivationRequest.clientX,
      clientY: previewActivationRequest.clientY
    });
  }, [
    active,
    bodyProblem,
    buffer?.error,
    node.projectRelativePath,
    previewActivationRequest
  ]);
  const geometry = canvasTextPresentationGeometry(node);
  const bodyRef = useCallback((element: HTMLDivElement | null) => {
    if (!element || !import.meta.env.DEV) {
      return;
    }
    const assertGeometry = () => {
      if (element.clientWidth > 0
        && element.clientHeight > 0
        && (element.clientWidth !== geometry.contentCssWidth
          || element.clientHeight !== geometry.contentCssHeight)) {
        throw new Error(
          `Canvas text presentation geometry mismatch for ${node.projectRelativePath}: `
          + `${element.clientWidth}x${element.clientHeight} != `
          + `${geometry.contentCssWidth}x${geometry.contentCssHeight}.`
        );
      }
    };
    assertGeometry();
  }, [geometry.contentCssHeight, geometry.contentCssWidth, node.projectRelativePath]);
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
  const failEditorActivation = useCallback((error: Error) => {
    setVisibleTextLayer('preview');
    setEditorActivationError(error);
  }, []);

  useEffect(() => {
    if (active) {
      setHandoffViewport(undefined);
    } else {
      setEditorActivationError(undefined);
      setFocusRequest(undefined);
    }
  }, [active]);

  useEffect(() => {
    if (active && buffer?.error !== undefined) {
      setVisibleTextLayer('preview');
    }
  }, [active, buffer?.error]);

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

  const editorBuffer = buffer && buffer.error === undefined && editorActivationError === undefined
    && (active || visibleTextLayer === 'editor')
    ? buffer
    : undefined;
  const showTextEditor = editorBuffer !== undefined;

  return (
    <section className="canvas-text-node">
      <CanvasNodeTitleBar
        icon={<FileText size={13} />}
        title={nodeDisplayName(node)}
        status={status ? <StatusPill tone={status.tone}>{status.label}</StatusPill> : null}
        actions={(
          <>
            <IconButton
              label={i18n.t('canvas.node.saveFile', { path: node.projectRelativePath })}
              title={i18n.t('canvas.node.save')}
              disabled={!buffer || !buffer.dirty || buffer.saving}
              icon={<Save size={13} />}
              onClick={() => void actions.saveTextFileBuffer(node.projectRelativePath)}
            />
            <IconButton
              label={i18n.t('canvas.node.discardFileChanges', { path: node.projectRelativePath })}
              title={i18n.t('canvas.node.discardChanges')}
              variant="danger"
              disabled={!buffer || !buffer.dirty || buffer.saving}
              icon={<DiscardChangesIcon size={13} />}
              onClick={() => void actions.discardTextFileBuffer(node.projectRelativePath)}
            />
            <IconButton
              label={i18n.t('canvas.node.openLargeEditorForFile', { path: node.projectRelativePath })}
              title={i18n.t('canvas.node.openLargeEditor')}
              icon={<Maximize2 size={13} />}
              onClick={() => actions.openTextEditorWindow(node.projectRelativePath)}
            />
          </>
        )}
      />
      <div
        ref={bodyRef}
        className={bodyProblem ? 'canvas-text-body problem' : 'canvas-text-body'}
        data-canvas-local-wheel="focus"
        data-canvas-node-zone={active ? 'passive' : 'activate'}
      >
        {bodyProblem ? (
          <div className="canvas-text-message">
            <AlertTriangle size={18} />
            <strong>{bodyProblem.title}</strong>
            <span>{bodyProblem.message}</span>
            {textPreviewBlockingProblem !== undefined && bodyProblem === textPreviewBlockingProblem ? (
              <Button
                className="db-canvas-node-retry"
                size="xs"
                iconStart={<RefreshCw size={12} />}
                onClick={retryCurrentTextPreview}
              >
                {i18n.t('canvas.node.retry')}
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            {showTextEditor ? (
              <CanvasTextEditorActivationBoundary onError={failEditorActivation}>
                <CanvasTextRenderProfileGate
                  profile={textRenderProfile}
                  pending={<div className="canvas-text-preview-empty" aria-busy="true" />}
                  requireExactProfile={visibleTextLayer === 'preview'}
                  onReady={() => workbenchStartupTimeline.mark('canvas-text-ready')}
                  onError={failEditorActivation}
                >
                  <React.Suspense fallback={<div className="canvas-text-preview-empty" aria-busy="true" />}>
                    <CanvasTextEditor
                      value={editorBuffer.content}
                      language={editorBuffer.language}
                      wordWrap={editorBuffer.wordWrap}
                      readOnly={!active}
                      visible={active}
                      published={visibleTextLayer === 'editor'}
                      focusRequest={active && visibleTextLayer === 'editor' ? focusRequest : undefined}
                      initialScrollTop={node.textViewport?.scrollTop}
                      initialScrollLeft={node.textViewport?.scrollLeft}
                      onChange={(content) => actions.updateTextFileBuffer(node.projectRelativePath, content)}
                      onSave={() => void actions.saveTextFileBuffer(node.projectRelativePath)}
                      onToggleWordWrap={() => actions.toggleTextFileWordWrap(node.projectRelativePath)}
                      onScrollPositionCommit={commitTextViewport}
                      onReadOnlyTransition={setHandoffViewport}
                      onLayoutReady={() => {
                        if (activeRef.current) {
                          setVisibleTextLayer('editor');
                        }
                      }}
                      onLayoutFailure={visibleTextLayer === 'preview' ? failEditorActivation : undefined}
                      onFocusRequestConsumed={(requestId) => {
                        setFocusRequest((current) => current?.requestId === requestId ? undefined : current);
                      }}
                    />
                  </React.Suspense>
                </CanvasTextRenderProfileGate>
              </CanvasTextEditorActivationBoundary>
            ) : null}
            {textRasterPreview.layers}
            {!showTextEditor && overlayProblem ? (
              <div className="canvas-text-message canvas-text-message--overlay">
                <AlertTriangle size={18} />
                <strong>{overlayProblem.title}</strong>
                <span>{overlayProblem.message}</span>
                {overlayProblem === textPreviewOverlayProblem ? (
                  <Button
                    className="db-canvas-node-retry"
                    size="xs"
                    iconStart={<RefreshCw size={12} />}
                    onClick={retryCurrentTextPreview}
                  >
                    {i18n.t('canvas.node.retry')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function textBufferStatus(
  buffer: TextFileBuffer | undefined,
  problem: { title: string; message: string } | undefined,
  contentRequested: boolean,
  i18n: WorkbenchI18n
): { label: string; tone: 'danger' | 'info' | 'loading' } | undefined {
  if (problem || buffer?.error) {
    return { label: i18n.t('canvas.node.error'), tone: 'danger' };
  }
  if (!buffer) {
    return contentRequested
      ? { label: i18n.t('canvas.node.loading'), tone: 'loading' }
      : undefined;
  }
  if (buffer.externalChange) {
    return { label: i18n.t('canvas.node.externalChange'), tone: 'info' };
  }
  if (buffer.saving) {
    return { label: i18n.t('canvas.node.saving'), tone: 'loading' };
  }
  return undefined;
}

function nodeDisplayName(node: ProjectedCanvasNode): string {
  return node.displayName;
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

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
