import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, File, FileText, Folder, Image as ImageIcon, Maximize2, Music2, RefreshCw, Save, Video } from 'lucide-react';
import type { ProjectedCanvasNode } from '@axis/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import type { ResizeHandle } from '../services/canvasInteraction';
import { CanvasMonacoEditor } from './CanvasMonacoEditor';
import { canvasImageRenderSources, canvasImageSourceUrl, type CanvasLoadedImage } from './canvasImagePreviews';

const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

export interface CanvasNodeElementViewProps {
  node: ProjectedCanvasNode;
  selected: boolean;
  hovered: boolean;
  viewportZoom: number;
  imagePreviewsEnabled: boolean;
  devicePixelRatio: number;
  actions: WorkbenchActions;
  textBuffer: TextFileBuffer | undefined;
  onPointerDown: (event: React.PointerEvent<Element>) => void;
  onPointerMove: (event: React.PointerEvent<Element>) => void;
  onPointerUp: (event: React.PointerEvent<Element>) => void;
  onPointerEnter: (event: React.PointerEvent<Element>) => void;
  onPointerLeave: (event: React.PointerEvent<Element>) => void;
  onContextMenu: (event: React.MouseEvent<Element>) => void;
  onResizePointerDown: (handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) => void;
}

function CanvasNodeElementViewComponent({
  node,
  selected,
  hovered,
  viewportZoom,
  imagePreviewsEnabled,
  devicePixelRatio,
  actions,
  textBuffer,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerEnter,
  onPointerLeave,
  onContextMenu,
  onResizePointerDown
}: CanvasNodeElementViewProps): React.ReactElement {
  const [mediaError, setMediaError] = useState<string>();
  const [mediaRetryNonce, setMediaRetryNonce] = useState(0);
  const [loadedImage, setLoadedImage] = useState<CanvasLoadedImage>();
  const ensureTextFileBuffer = actions.ensureTextFileBuffer;
  const nodeRevision = node.availability.state === 'available' ? node.availability.revision : undefined;
  const mediaSourceKey = useMemo(() => {
    return canvasImageSourceUrl({
      node,
      viewportZoom,
      imagePreviewsEnabled,
      devicePixelRatio
    });
  }, [devicePixelRatio, imagePreviewsEnabled, node, viewportZoom]);
  const mediaSrc = mediaSourceKey;
  const imageLoadKey = node.mediaKind === 'image' && mediaSrc ? `${mediaSrc}:${mediaRetryNonce}` : undefined;
  const imageRenderSources = canvasImageRenderSources({
    selectedSrc: node.mediaKind === 'image' ? mediaSrc : undefined,
    loadKey: imageLoadKey,
    loadedImage,
    loadError: mediaError
  });
  const selectedImageLoadKeyRef = useRef<string | undefined>(undefined);
  selectedImageLoadKeyRef.current = imageLoadKey;

  useEffect(() => {
    setMediaError(undefined);
    setMediaRetryNonce(0);
    if (node.mediaKind !== 'image' || !mediaSourceKey) {
      setLoadedImage(undefined);
    }
  }, [mediaSourceKey, node.mediaKind]);

  useEffect(() => {
    if (node.mediaKind !== 'text' || node.availability.state !== 'available') {
      return;
    }
    void ensureTextFileBuffer(node.projectRelativePath, nodeRevision);
  }, [node.mediaKind, node.projectRelativePath, nodeRevision, ensureTextFileBuffer]);

  const availabilityProblem = node.availability.state === 'available'
    ? undefined
    : { title: nodeAvailabilityTitle(node.availability.state), message: node.availability.message };
  const mediaProblem = mediaError ? { title: 'Load Error', message: mediaError } : undefined;
  const problem = mediaProblem ?? availabilityProblem;
  const imageHasLoadedFrame = node.mediaKind === 'image' && imageRenderSources.loadedImage !== undefined;
  const canRenderMediaPreview = node.availability.state === 'available' && mediaSrc !== undefined && (!problem || imageHasLoadedFrame);
  const retryMediaLoad = () => {
    setMediaError(undefined);
    setMediaRetryNonce((current) => current + 1);
  };
  const promotePendingImage = (nextImage: CanvasLoadedImage) => {
    if (selectedImageLoadKeyRef.current !== nextImage.loadKey) {
      return;
    }
    setLoadedImage(nextImage);
  };

  const visible = node.visible !== false;
  const locked = node.locked === true;
  const className = [
    'canvas-node-element',
    node.mediaKind,
    selected ? 'selected' : '',
    hovered ? 'hovered' : '',
    node.nodeKind,
    usesFixedNodePresentation(node) ? 'fixed-presentation' : '',
    visible ? '' : 'hidden',
    locked ? 'locked' : ''
  ].filter(Boolean).join(' ');
  const nodeContent = (
    <>
      {node.nodeKind === 'directory' || node.mediaKind === 'unknown' || !node.mediaKind ? (
        <CanvasGenericNodeContent node={node} problem={problem} />
      ) : node.mediaKind === 'text' ? (
        <CanvasTextNodeContent
          node={node}
          buffer={textBuffer}
          problem={problem}
          selected={selected}
          actions={actions}
          onTitlePointerDown={onPointerDown}
          onTitlePointerMove={onPointerMove}
          onTitlePointerUp={onPointerUp}
        />
      ) : canRenderMediaPreview ? (
        <div className="canvas-node-preview">
          {node.mediaKind === 'image' ? (
            <>
              {imageRenderSources.loadedImage ? (
                <img
                  key={imageRenderSources.loadedImage.loadKey}
                  src={imageRenderSources.loadedImage.src}
                  alt={node.projectRelativePath}
                  draggable={false}
                  style={{ objectFit: 'fill' }}
                />
              ) : null}
              {imageRenderSources.pendingImage ? (
                <img
                  key={imageRenderSources.pendingImage.loadKey}
                  src={imageRenderSources.pendingImage.src}
                  alt={imageRenderSources.loadedImage ? '' : node.projectRelativePath}
                  aria-hidden={imageRenderSources.loadedImage ? true : undefined}
                  draggable={false}
                  style={{ objectFit: 'fill' }}
                  onLoad={() => promotePendingImage(imageRenderSources.pendingImage!)}
                  onError={() => setMediaError(`Unable to load ${node.projectRelativePath}.`)}
                />
              ) : null}
              {imageRenderSources.errorOverlay ? (
                <CanvasNodeMediaErrorOverlay
                  message={imageRenderSources.errorOverlay.message}
                  onRetry={retryMediaLoad}
                />
              ) : null}
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
          <div className={problem ? 'canvas-node-placeholder problem' : 'canvas-node-placeholder'}>
            {problem ? <AlertTriangle size={22} /> : node.mediaKind === 'video' ? <Video size={22} /> : node.mediaKind === 'audio' ? <Music2 size={22} /> : <ImageIcon size={22} />}
            <strong>{problem?.title ?? (node.mediaKind === 'video' ? 'Video' : node.mediaKind === 'audio' ? 'Audio' : 'Image')}</strong>
            <span>{problem?.message ?? node.projectRelativePath}</span>
            {mediaProblem ? (
              <button
                type="button"
                className="canvas-node-retry"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={retryMediaLoad}
              >
                <RefreshCw size={12} />
                Retry
              </button>
            ) : null}
          </div>
        </div>
      )}
      {node.mediaKind === 'video' || node.mediaKind === 'audio' ? (
        <div className="canvas-node-caption">
          <span>{node.projectRelativePath}</span>
        </div>
      ) : null}
    </>
  );

  return (
    <div
      data-canvas-entity="node"
      data-canvas-node-path={node.projectRelativePath}
      className={className}
      style={{
        left: 0,
        top: 0,
        transform: `translate(${node.x}px, ${node.y}px)`,
        width: node.width,
        height: node.height,
        zIndex: node.z
      } as React.CSSProperties}
      onPointerDown={node.mediaKind === 'text' ? undefined : onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onContextMenu={onContextMenu}
    >
      {visible ? usesFixedNodePresentation(node) ? (
        <div className="canvas-node-presentation">
          {nodeContent}
        </div>
      ) : nodeContent : null}
      {selected && !locked ? RESIZE_HANDLES.map((handle) => (
        <button
          key={handle}
          type="button"
          className={`canvas-node-resize ${handle}`}
          aria-label={`Resize node ${handle}`}
          title={`Resize ${handle}`}
          onPointerDown={(event) => onResizePointerDown(handle, event)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      )) : null}
    </div>
  );
}

export const CanvasNodeElementView = React.memo(CanvasNodeElementViewComponent, areCanvasNodeElementViewPropsEqual);

export function areCanvasNodeElementViewPropsEqual(
  previous: CanvasNodeElementViewProps,
  next: CanvasNodeElementViewProps
): boolean {
  return previous.node === next.node
    && previous.selected === next.selected
    && previous.hovered === next.hovered
    && previous.viewportZoom === next.viewportZoom
    && previous.imagePreviewsEnabled === next.imagePreviewsEnabled
    && previous.devicePixelRatio === next.devicePixelRatio
    && (previous.node.mediaKind === 'text' ? previous.actions === next.actions : true)
    && previous.textBuffer === next.textBuffer;
}

function usesFixedNodePresentation(node: ProjectedCanvasNode): boolean {
  return node.nodeKind === 'directory'
    || node.mediaKind === 'text'
    || node.mediaKind === 'audio'
    || node.mediaKind === 'unknown'
    || !node.mediaKind;
}

function CanvasGenericNodeContent({
  node,
  problem
}: {
  node: ProjectedCanvasNode;
  problem: { title: string; message: string } | undefined;
}): React.ReactElement {
  const label = node.projectRelativePath.split('/').pop() ?? node.projectRelativePath;
  return (
    <div className={problem ? 'canvas-node-generic problem' : 'canvas-node-generic'}>
      {problem ? <AlertTriangle size={20} /> : node.nodeKind === 'directory' ? <Folder size={20} /> : <File size={20} />}
      <strong>{problem?.title ?? label}</strong>
      <span>{problem?.message ?? node.projectRelativePath}</span>
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
    <div className="canvas-node-error-overlay">
      <AlertTriangle size={16} />
      <span>{message}</span>
      <button
        type="button"
        className="canvas-node-retry"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onRetry}
      >
        <RefreshCw size={12} />
        Retry
      </button>
    </div>
  );
}

function CanvasTextNodeContent({
  node,
  buffer,
  problem,
  selected,
  actions,
  onTitlePointerDown,
  onTitlePointerMove,
  onTitlePointerUp
}: {
  node: ProjectedCanvasNode;
  buffer: TextFileBuffer | undefined;
  problem: { title: string; message: string } | undefined;
  selected: boolean;
  actions: WorkbenchActions;
  onTitlePointerDown: (event: React.PointerEvent<Element>) => void;
  onTitlePointerMove: (event: React.PointerEvent<Element>) => void;
  onTitlePointerUp: (event: React.PointerEvent<Element>) => void;
}): React.ReactElement {
  const status = textBufferStatus(buffer, problem);
  const selectSelf = () => {
    if (!selected) {
      actions.selectCanvasEntity({ kind: 'node', projectRelativePath: node.projectRelativePath });
    }
  };

  return (
    <section className="canvas-text-node" data-canvas-local-wheel="true">
      <div
        className="canvas-text-titlebar"
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
      >
        <FileText size={13} />
        <strong>{node.projectRelativePath.split('/').pop() ?? node.projectRelativePath}</strong>
        <span className={status.className}>{status.label}</span>
        <button
          type="button"
          aria-label={`Save ${node.projectRelativePath}`}
          title="Save"
          disabled={!buffer || !buffer.dirty || buffer.saving}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void actions.saveTextFileBuffer(node.projectRelativePath)}
        >
          <Save size={13} />
        </button>
        <button
          type="button"
          aria-label={`Open ${node.projectRelativePath} in large editor`}
          title="Open large editor"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => actions.openTextEditorWindow(node.projectRelativePath)}
        >
          <Maximize2 size={13} />
        </button>
      </div>
      <div
        className={problem || buffer?.error ? 'canvas-text-body problem' : 'canvas-text-body'}
        onPointerDown={(event) => {
          event.stopPropagation();
          selectSelf();
        }}
      >
        {problem || buffer?.error ? (
          <div className="canvas-text-message" data-canvas-text-editor="true">
            <AlertTriangle size={18} />
            <strong>{problem?.title ?? 'Text Error'}</strong>
            <span>{problem?.message ?? buffer?.error}</span>
          </div>
        ) : buffer ? (
          <CanvasMonacoEditor
            value={buffer.content}
            language={buffer.language}
            wordWrap={buffer.wordWrap}
            onChange={(content) => actions.updateTextFileBuffer(node.projectRelativePath, content)}
            onSave={() => void actions.saveTextFileBuffer(node.projectRelativePath)}
            onToggleWordWrap={() => actions.toggleTextFileWordWrap(node.projectRelativePath)}
          />
        ) : (
          <div className="canvas-text-message" data-canvas-text-editor="true">
            <FileText size={18} />
            <span>Loading text</span>
          </div>
        )}
      </div>
    </section>
  );
}

function textBufferStatus(buffer: TextFileBuffer | undefined, problem: { title: string; message: string } | undefined): { label: string; className: string } {
  if (problem || buffer?.error) {
    return { label: 'Error', className: 'error' };
  }
  if (!buffer) {
    return { label: 'Loading', className: 'loading' };
  }
  if (buffer.externalChange) {
    return { label: 'External change', className: 'external' };
  }
  if (buffer.saving) {
    return { label: 'Saving', className: 'saving' };
  }
  if (buffer.dirty) {
    return { label: 'Unsaved', className: 'dirty' };
  }
  return { label: 'Saved', className: 'saved' };
}

function nodeAvailabilityTitle(state: ProjectedCanvasNode['availability']['state']): string {
  if (state === 'missing') {
    return 'Missing File';
  }
  return 'Unreadable File';
}
