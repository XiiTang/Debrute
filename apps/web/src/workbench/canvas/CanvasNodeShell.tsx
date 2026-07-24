import React, { useLayoutEffect, useRef } from 'react';
import type { CanvasFeedbackEntry, CanvasFeedbackGeometry, CanvasTextViewportState, ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import type { ResizeHandle } from '../services/canvasInteraction';
import type { CanvasStageRuntime } from './runtime/CanvasStageRuntime';
import { CanvasFeedbackFrame, canvasFeedbackEntryHasFeedback } from './CanvasFeedbackFrame';
import { CanvasNodeContent } from './CanvasNodeContent';
import type { CanvasMediaFeedbackDraftRegion, CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import type { CanvasTextPreviewSource } from './CanvasTextPreviewRuntime';
import type { CanvasVideoPreviewSource } from './canvasVideoPreviews';
import type { CanvasVideoPlayerHandle } from './CanvasVideoPlayerAdapter';

const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

export interface CanvasNodeShellProps {
  node: ProjectedCanvasNode;
  selected: boolean;
  textEditorActive: boolean;
  hovered: boolean;
  culled: boolean;
  zIndex: number;
  stageRuntime: CanvasStageRuntime;
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
  localFeedbackMode?: CanvasMediaFeedbackMode | undefined;
  pendingFeedbackRegion?: CanvasMediaFeedbackDraftRegion | undefined;
  activeFeedbackMomentTimeSeconds?: number | undefined;
  onLocalFeedbackDraft?: ((input: {
    projectRelativePath: string;
    geometry: CanvasFeedbackGeometry;
  }) => void) | undefined;
  onPointerDown: (node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => void;
  onPointerMove: (event: React.PointerEvent<Element>) => void;
  onPointerUp: (event: React.PointerEvent<Element>) => void;
  onPointerEnter: (node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => void;
  onPointerLeave: (node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => void;
  onContextMenu: (node: ProjectedCanvasNode, event: React.MouseEvent<Element>) => void;
  onSelectNode: (node: ProjectedCanvasNode) => void;
  onResizePointerDown: (node: ProjectedCanvasNode, handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) => void;
  onVideoPlayerMounted: (projectRelativePath: string) => void;
  onVideoPlayingChange: (projectRelativePath: string, playing: boolean) => void;
  onRegisterVideoTarget: (projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined) => void;
  onUpdateVideoPlaybackTime: (projectRelativePath: string, currentTimeSeconds: number) => void | Promise<void>;
  onUpdateTextViewport: (projectRelativePath: string, viewport: CanvasTextViewportState) => void | Promise<void>;
  onVideoPreviewError?: ((projectRelativePath: string, preview: CanvasVideoPreviewSource, message: string) => void) | undefined;
}

function CanvasNodeShellComponent({
  node,
  selected,
  textEditorActive,
  hovered,
  culled,
  zIndex,
  stageRuntime,
  actions,
  textBuffer,
  textPreview,
  pendingTextPreview,
  textPreviewCommittedSourceKey,
  textPreviewError,
  videoPreview,
  videoPreviewError,
  forceVideoPlayerMounted,
  feedbackEntry,
  localFeedbackMode,
  pendingFeedbackRegion,
  activeFeedbackMomentTimeSeconds,
  onLocalFeedbackDraft,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerEnter,
  onPointerLeave,
  onContextMenu,
  onSelectNode,
  onResizePointerDown,
  onVideoPlayerMounted,
  onVideoPlayingChange,
  onRegisterVideoTarget,
  onUpdateVideoPlaybackTime,
  onUpdateTextViewport,
  onVideoPreviewError
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

  const hasFeedback = canvasFeedbackEntryHasFeedback(feedbackEntry);
  const className = [
    'canvas-node-element',
    'canvas-node-shell',
    'db-canvas-node-frame',
    node.mediaKind,
    selected ? 'selected' : '',
    hovered ? 'hovered' : '',
    hasFeedback ? 'canvas-node-has-feedback' : '',
    node.nodeKind,
    usesFixedNodePresentation(node) ? 'fixed-presentation' : ''
  ].filter(Boolean).join(' ');
  const content = (
    <CanvasNodeContent
      node={node}
      selected={node.mediaKind === 'text' ? textEditorActive : selected}
      culled={culled}
      actions={actions}
      textBuffer={textBuffer}
      textPreview={textPreview}
      pendingTextPreview={pendingTextPreview}
      textPreviewCommittedSourceKey={textPreviewCommittedSourceKey}
      textPreviewError={textPreviewError}
      videoPreview={videoPreview}
      videoPreviewError={videoPreviewError}
      forceVideoPlayerMounted={forceVideoPlayerMounted}
      feedbackEntry={feedbackEntry}
      localFeedbackMode={localFeedbackMode}
      pendingFeedbackRegion={pendingFeedbackRegion}
      activeFeedbackMomentTimeSeconds={activeFeedbackMomentTimeSeconds}
      onLocalFeedbackDraft={onLocalFeedbackDraft}
      onVideoPlayerMounted={onVideoPlayerMounted}
      onVideoPlayingChange={onVideoPlayingChange}
      onRegisterVideoTarget={onRegisterVideoTarget}
      onUpdateVideoPlaybackTime={onUpdateVideoPlaybackTime}
      onUpdateTextViewport={onUpdateTextViewport}
      onVideoPreviewError={onVideoPreviewError}
      onSelectNode={() => onSelectNode(node)}
      onTitlePointerDown={(event) => onPointerDown(node, event)}
      onTitlePointerMove={onPointerMove}
      onTitlePointerUp={onPointerUp}
    />
  );

  return (
    <div
      ref={elementRef}
      data-canvas-entity="node"
      data-canvas-node-path={node.projectRelativePath}
      data-canvas-node-kind={node.nodeKind}
      data-canvas-media-kind={node.mediaKind}
      data-project-relative-path={node.projectRelativePath}
      className={className}
      style={{ left: 0, top: 0 } as React.CSSProperties}
      onPointerDown={node.mediaKind === 'text' ? undefined : (event) => onPointerDown(node, event)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerEnter={(event) => onPointerEnter(node, event)}
      onPointerLeave={(event) => onPointerLeave(node, event)}
      onContextMenu={(event) => onContextMenu(node, event)}
    >
      {usesFixedNodePresentation(node)
        ? <div className="canvas-node-presentation">{content}</div>
        : content}
      <CanvasFeedbackFrame entry={feedbackEntry} />
      {selected ? RESIZE_HANDLES.map((handle) => (
        <button
          key={handle}
          type="button"
          className={`canvas-node-resize ${handle}`}
          aria-label={`Resize node ${handle}`}
          title={`Resize ${handle}`}
          onPointerDown={(event) => onResizePointerDown(node, handle, event)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
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
    && previous.selected === next.selected
    && previous.textEditorActive === next.textEditorActive
    && previous.hovered === next.hovered
    && previous.culled === next.culled
    && previous.zIndex === next.zIndex
    && previous.stageRuntime === next.stageRuntime
    && (previous.node.mediaKind === 'text' ? previous.actions === next.actions : true)
    && previous.textBuffer === next.textBuffer
    && previous.textPreview === next.textPreview
    && previous.pendingTextPreview === next.pendingTextPreview
    && previous.textPreviewCommittedSourceKey === next.textPreviewCommittedSourceKey
    && previous.textPreviewError === next.textPreviewError
    && previous.videoPreview === next.videoPreview
    && previous.videoPreviewError === next.videoPreviewError
    && previous.forceVideoPlayerMounted === next.forceVideoPlayerMounted
    && previous.feedbackEntry === next.feedbackEntry
    && previous.localFeedbackMode === next.localFeedbackMode
    && previous.pendingFeedbackRegion === next.pendingFeedbackRegion
    && previous.activeFeedbackMomentTimeSeconds === next.activeFeedbackMomentTimeSeconds
    && previous.onLocalFeedbackDraft === next.onLocalFeedbackDraft
    && previous.onPointerDown === next.onPointerDown
    && previous.onPointerMove === next.onPointerMove
    && previous.onPointerUp === next.onPointerUp
    && previous.onPointerEnter === next.onPointerEnter
    && previous.onPointerLeave === next.onPointerLeave
    && previous.onContextMenu === next.onContextMenu
    && previous.onSelectNode === next.onSelectNode
    && previous.onResizePointerDown === next.onResizePointerDown
    && previous.onVideoPlayerMounted === next.onVideoPlayerMounted
    && previous.onVideoPlayingChange === next.onVideoPlayingChange
    && previous.onRegisterVideoTarget === next.onRegisterVideoTarget
    && previous.onUpdateVideoPlaybackTime === next.onUpdateVideoPlaybackTime
    && previous.onUpdateTextViewport === next.onUpdateTextViewport
    && previous.onVideoPreviewError === next.onVideoPreviewError;
}

function usesFixedNodePresentation(node: ProjectedCanvasNode): boolean {
  return node.availability.state !== 'available'
    || node.nodeKind === 'directory'
    || node.mediaKind === 'text'
    || node.mediaKind === 'audio'
    || node.mediaKind === 'unknown'
    || !node.mediaKind;
}
