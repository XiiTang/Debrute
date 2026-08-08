import React, { useLayoutEffect, useRef } from 'react';
import type { CanvasFeedbackEntry, CanvasFeedbackGeometry, CanvasTextViewportState } from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from './CanvasScene.js';
import type { TextFileBuffer } from '../../types';
import type { ResizeHandle } from '../services/canvasInteraction';
import type { CanvasStageRuntime } from './runtime/CanvasStageRuntime';
import { CanvasNodeContent } from './CanvasNodeContent';
import type { CanvasMediaFeedbackDraftRegion, CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import type { CanvasRasterPreviewRequest } from './CanvasRasterPreviewPresentation';
import type { CanvasVideoPlayerHandle } from './CanvasVideoPlayerAdapter';
import {
  CANVAS_NODE_PRESENTATION_SCALE,
  canvasTextPresentationGeometry
} from './CanvasNodePresentationGeometry.js';
import type { CanvasContentHandoffRequest } from './CanvasDomInteractionAdapter.js';
import type { CanvasSceneActions } from './CanvasSceneActions.js';

const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

export interface CanvasNodeShellProps {
  node: ProjectedCanvasNode;
  cut: boolean;
  showResizeHandles: boolean;
  contentInteractionActive: boolean;
  zIndex: number;
  stageRuntime: CanvasStageRuntime;
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
  onResizePointerDown: (node: ProjectedCanvasNode, handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) => void;
  onVideoPlayerMounted: (projectRelativePath: string) => void;
  onVideoPlayingChange: (projectRelativePath: string, playing: boolean) => void;
  onContentError: (projectRelativePath: string) => void;
  onContentHandoffConsumed: (requestId: number) => void;
  onRegisterVideoTarget: (projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined) => void;
  onUpdateVideoPlaybackTime: (projectRelativePath: string, currentTimeMs: number) => void | Promise<void>;
  onUpdateTextViewport: (projectRelativePath: string, viewport: CanvasTextViewportState) => void | Promise<void>;
}

function CanvasNodeShellComponent({
  node,
  cut,
  showResizeHandles,
  contentInteractionActive,
  zIndex,
  stageRuntime,
  actions,
  textBuffer,
  textPreviewRequest,
  textPreviewError,
  videoPreviewRequest,
  videoPreviewError,
  forceVideoPlayerMounted,
  contentHandoffRequest,
  feedbackEntry,
  activeFeedbackItemId,
  localFeedbackMode,
  localFeedbackRegions,
  activeFeedbackMomentTimeSeconds,
  onLocalFeedbackDraft,
  onFeedbackItemActivate,
  onResizePointerDown,
  onVideoPlayerMounted,
  onVideoPlayingChange,
  onContentError,
  onContentHandoffConsumed,
  onRegisterVideoTarget,
  onUpdateVideoPlaybackTime,
  onUpdateTextViewport,
}: CanvasNodeShellProps): React.ReactElement {
  const elementRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }
    return stageRuntime.registerNodeShell(node.projectRelativePath, element);
  }, [stageRuntime, node.projectRelativePath]);

  useLayoutEffect(() => {
    stageRuntime.setNodeLayout(node.projectRelativePath, {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      z: zIndex
    });
  }, [stageRuntime, node.height, node.projectRelativePath, node.width, node.x, node.y, zIndex]);

  const textPresentationGeometry = node.mediaKind === 'text'
    ? canvasTextPresentationGeometry(node)
    : undefined;
  const className = [
    'canvas-node-element',
    'canvas-node-shell',
    'db-canvas-node-frame',
    node.mediaKind,
    cut ? 'canvas-cut-source' : '',
    node.nodeKind,
    usesFixedNodePresentation(node) ? 'fixed-presentation' : ''
  ].filter(Boolean).join(' ');
  const content = (
    <CanvasNodeContent
      node={node}
      contentInteractionActive={contentInteractionActive}
      actions={actions}
      textBuffer={textBuffer}
      textPreviewRequest={textPreviewRequest}
      textPreviewError={textPreviewError}
      videoPreviewRequest={videoPreviewRequest}
      videoPreviewError={videoPreviewError}
      forceVideoPlayerMounted={forceVideoPlayerMounted}
      contentHandoffRequest={contentHandoffRequest}
      feedbackEntry={feedbackEntry}
      activeFeedbackItemId={activeFeedbackItemId}
      localFeedbackMode={localFeedbackMode}
      localFeedbackRegions={localFeedbackRegions}
      activeFeedbackMomentTimeSeconds={activeFeedbackMomentTimeSeconds}
      onLocalFeedbackDraft={onLocalFeedbackDraft}
      onFeedbackItemActivate={onFeedbackItemActivate}
      onVideoPlayerMounted={onVideoPlayerMounted}
      onVideoPlayingChange={onVideoPlayingChange}
      onContentError={onContentError}
      onContentHandoffConsumed={onContentHandoffConsumed}
      onRegisterVideoTarget={onRegisterVideoTarget}
      onUpdateVideoPlaybackTime={onUpdateVideoPlaybackTime}
      onUpdateTextViewport={onUpdateTextViewport}
    />
  );

  return (
    <div
      ref={elementRef}
      data-canvas-entity="node"
      data-canvas-node-path={node.projectRelativePath}
      data-canvas-node-kind={node.nodeKind}
      data-canvas-media-kind={node.mediaKind}
      data-canvas-content-active={contentInteractionActive ? 'true' : undefined}
      data-project-relative-path={node.projectRelativePath}
      className={className}
      style={{
        left: 0,
        top: 0,
        '--canvas-node-presentation-scale': CANVAS_NODE_PRESENTATION_SCALE,
        '--canvas-node-presentation-scale-inverse': 1 / CANVAS_NODE_PRESENTATION_SCALE
      } as React.CSSProperties}
    >
      {usesFixedNodePresentation(node)
        ? (
            <div
              className="canvas-node-presentation"
              style={textPresentationGeometry ? {
                width: textPresentationGeometry.frameCssWidth,
                height: textPresentationGeometry.frameCssHeight
              } : undefined}
            >
              {content}
            </div>
          )
        : content}
      {showResizeHandles ? RESIZE_HANDLES.map((handle) => (
        <button
          key={handle}
          type="button"
          className={`canvas-node-resize ${handle}`}
          aria-label={`Resize node ${handle}`}
          title={`Resize ${handle}`}
          data-canvas-node-zone="resize"
          onPointerDown={(event) => onResizePointerDown(node, handle, event)}
        />
      )) : null}
    </div>
  );
}

export const CanvasNodeShell = React.memo(CanvasNodeShellComponent, areCanvasNodeShellPropsEqual);

export function areCanvasNodeShellPropsEqual(
  previous: CanvasNodeShellProps,
  next: CanvasNodeShellProps
): boolean {
  return previous.node === next.node
    && previous.cut === next.cut
    && previous.showResizeHandles === next.showResizeHandles
    && previous.contentInteractionActive === next.contentInteractionActive
    && previous.zIndex === next.zIndex
    && previous.stageRuntime === next.stageRuntime
    && (previous.node.mediaKind === 'text' ? previous.actions === next.actions : true)
    && previous.textBuffer === next.textBuffer
    && previous.textPreviewRequest === next.textPreviewRequest
    && previous.textPreviewError === next.textPreviewError
    && previous.videoPreviewRequest === next.videoPreviewRequest
    && previous.videoPreviewError === next.videoPreviewError
    && previous.forceVideoPlayerMounted === next.forceVideoPlayerMounted
    && previous.contentHandoffRequest === next.contentHandoffRequest
    && previous.feedbackEntry === next.feedbackEntry
    && previous.activeFeedbackItemId === next.activeFeedbackItemId
    && previous.localFeedbackMode === next.localFeedbackMode
    && previous.localFeedbackRegions === next.localFeedbackRegions
    && previous.activeFeedbackMomentTimeSeconds === next.activeFeedbackMomentTimeSeconds
    && previous.onLocalFeedbackDraft === next.onLocalFeedbackDraft
    && previous.onFeedbackItemActivate === next.onFeedbackItemActivate
    && previous.onResizePointerDown === next.onResizePointerDown
    && previous.onVideoPlayerMounted === next.onVideoPlayerMounted
    && previous.onVideoPlayingChange === next.onVideoPlayingChange
    && previous.onContentError === next.onContentError
    && previous.onContentHandoffConsumed === next.onContentHandoffConsumed
    && previous.onRegisterVideoTarget === next.onRegisterVideoTarget
    && previous.onUpdateVideoPlaybackTime === next.onUpdateVideoPlaybackTime
    && previous.onUpdateTextViewport === next.onUpdateTextViewport;
}

function usesFixedNodePresentation(node: ProjectedCanvasNode): boolean {
  return node.availability.state !== 'available'
    || node.nodeKind === 'directory'
    || node.mediaKind === 'text'
    || node.mediaKind === 'audio'
    || node.mediaKind === 'unknown'
    || !node.mediaKind
    || (node.mediaKind === 'image' && !node.imageDimensions)
    || (node.mediaKind === 'video' && !node.videoPresentation);
}
