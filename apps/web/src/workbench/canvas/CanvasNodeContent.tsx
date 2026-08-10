import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, File, FileText, Folder, FolderOpen, Image as ImageIcon, Maximize2, RefreshCw, Save } from '../ui/index.js';
import type { CanvasFeedbackEntry, CanvasFeedbackGeometry, CanvasFeedbackSpatialItem, CanvasTextViewportState } from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from './CanvasScene.js';
import type { TextFileBuffer } from '../../types';
import { CanvasVideoNodeContent } from './CanvasVideoNodeContent';
import { CanvasAudioNodeContent } from './CanvasAudioNodeContent.js';
import type { CanvasVideoPlayerHandle } from './CanvasVideoPlayerAdapter';
import type { CanvasContentHandoffRequest } from './CanvasDomInteractionAdapter.js';
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
import {
  CanvasContentErrorPresentation,
  CanvasNodeErrorPresentation
} from './CanvasNodeErrorPresentation';
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
} from './CanvasNodePresentationGeometry.js';

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
  contentHandoffRequest?: CanvasContentHandoffRequest | undefined;
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
  onContentError: (projectRelativePath: string) => void;
  onContentHandoffConsumed?: ((requestId: number) => void) | undefined;
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
  contentHandoffRequest,
  feedbackEntry,
  activeFeedbackItemId,
  localFeedbackMode,
  localFeedbackRegions,
  activeFeedbackMomentTimeSeconds,
  onLocalFeedbackDraft,
  onFeedbackItemActivate,
  onVideoPlayerMounted,
  onVideoPlayingChange,
  onContentError,
  onContentHandoffConsumed,
  onRegisterVideoTarget,
  onUpdateVideoPlaybackTime,
  onUpdateTextViewport
}: CanvasNodeContentProps): React.ReactElement {
  const i18n = useI18n();
  const requestedTextBufferKeyRef = useRef<string | undefined>(undefined);
  const ensureTextFileBufferRef = useRef(actions.ensureTextFileBuffer);
  const textBufferEnsureKey = canvasTextBufferEnsureKey(
    node,
    textBuffer,
    contentInteractionActive
  );
  ensureTextFileBufferRef.current = actions.ensureTextFileBuffer;

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
      || node.availability.state === 'directory'
      || node.availability.state === 'resolving'
    ? undefined
    : { title: nodeAvailabilityTitle(node.availability.state, i18n), message: node.availability.message };
  const problem = availabilityProblem;

  if (node.availability.state === 'resolving') {
    return <CanvasGenericNodeContent node={node} problem={undefined} />;
  }

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
        contentHandoffRequest={contentHandoffRequest}
        onContentError={onContentError}
        onContentHandoffConsumed={onContentHandoffConsumed}
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
        contentHandoffRequest={contentHandoffRequest}
        onPlayerMounted={onVideoPlayerMounted}
        onPlayingChange={onVideoPlayingChange}
        onContentError={onContentError}
        onContentHandoffConsumed={onContentHandoffConsumed}
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

  if (node.mediaKind === 'audio') {
    return (
      <CanvasAudioNodeContent
        node={node}
        contentInteractionActive={contentInteractionActive}
        onContentError={onContentError}
      />
    );
  }

  const canRenderMediaPreview = node.availability.state === 'available'
    && node.mediaKind === 'image';

  return (
    <>
      {canRenderMediaPreview ? (
        <div
          className="canvas-node-preview"
        >
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
        </div>
      ) : (
        <div className="canvas-node-preview">
          <div className={problem ? 'db-canvas-node-placeholder db-canvas-node-placeholder--problem' : 'db-canvas-node-placeholder'}>
            {problem ? <AlertTriangle size={22} /> : <ImageIcon size={22} />}
            <strong>{problem?.title ?? mediaKindLabel(node.mediaKind, i18n)}</strong>
            <span>{problem?.message ?? nodeDisplayName(node)}</span>
          </div>
        </div>
      )}
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
  if (
    textBuffer?.projectRelativePath === node.projectRelativePath
    && textBuffer.error === undefined
  ) {
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
  let NodeIcon = File;
  if (node.nodeKind === 'directory') {
    NodeIcon = node.folderDisclosure === 'disclosed' ? FolderOpen : Folder;
  }

  return (
    <div className={className}>
      <NodeIcon size={20} />
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
  contentHandoffRequest,
  onContentError,
  onContentHandoffConsumed,
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
  contentHandoffRequest?: CanvasContentHandoffRequest | undefined;
  onContentError: (projectRelativePath: string) => void;
  onContentHandoffConsumed?: ((requestId: number) => void) | undefined;
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
  const editorActivationProblem = buffer?.error !== undefined || editorActivationError !== undefined
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
  const status = problem || editorActivationProblem || textPreviewProblem
    ? undefined
    : textBufferStatus(buffer, active, i18n);
  useEffect(() => {
    if (
      contentHandoffRequest?.kind !== 'text-caret'
      || contentHandoffRequest.projectRelativePath !== node.projectRelativePath
      || !active
      || lastActivationRequestIdRef.current === contentHandoffRequest.requestId
    ) {
      return;
    }
    lastActivationRequestIdRef.current = contentHandoffRequest.requestId;
    setEditorActivationError(undefined);
    if (currentTextPreviewError) {
      retryCurrentTextPreview();
    }
    setFocusRequest({
      requestId: contentHandoffRequest.requestId,
      clientX: contentHandoffRequest.clientX,
      clientY: contentHandoffRequest.clientY
    });
    onContentHandoffConsumed?.(contentHandoffRequest.requestId);
  }, [
    active,
    retryCurrentTextPreview,
    currentTextPreviewError,
    node.projectRelativePath,
    contentHandoffRequest,
    onContentHandoffConsumed
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
    onContentError(node.projectRelativePath);
  }, [node.projectRelativePath, onContentError]);

  useEffect(() => {
    if (active) {
      setHandoffViewport(undefined);
    } else {
      setFocusRequest(undefined);
    }
  }, [active]);

  useEffect(() => {
    if (active && buffer?.error !== undefined) {
      setVisibleTextLayer('preview');
      onContentError(node.projectRelativePath);
    }
  }, [active, buffer?.error, node.projectRelativePath, onContentError]);

  const hasAvailabilityProblem = problem !== undefined;
  useEffect(() => {
    if (active && hasAvailabilityProblem) {
      onContentError(node.projectRelativePath);
    }
  }, [active, hasAvailabilityProblem, node.projectRelativePath, onContentError]);

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
        data-canvas-node-zone="content"
      >
        {bodyProblem ? (
          <CanvasContentErrorPresentation message={`${bodyProblem.title}: ${bodyProblem.message}`} />
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
              <CanvasContentErrorPresentation message={`${overlayProblem.title}: ${overlayProblem.message}`} />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function textBufferStatus(
  buffer: TextFileBuffer | undefined,
  contentRequested: boolean,
  i18n: WorkbenchI18n
): { label: string; tone: 'danger' | 'info' | 'loading' } | undefined {
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
