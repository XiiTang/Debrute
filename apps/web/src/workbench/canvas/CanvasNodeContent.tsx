import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, File, FileText, Folder, Image as ImageIcon, Maximize2, Music2, RefreshCw, Save, Video } from 'lucide-react';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { CanvasMonacoEditor } from './CanvasMonacoEditor';
import { useCanvasImageNodeAsset, type CanvasImageNodeAssetHookState } from './CanvasImageNodeAssetContext';

export interface CanvasNodeContentProps {
  node: ProjectedCanvasNode;
  selected: boolean;
  culled: boolean;
  actions: WorkbenchActions;
  textBuffer: TextFileBuffer | undefined;
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
        actions={actions}
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
            <CanvasImageNodeContent node={node} culled={culled} />
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
  const pendingHandoffCancelRef = useRef<(() => void) | undefined>(undefined);
  const nextImageRef = useRef<HTMLImageElement | null>(null);
  const nextLoadKey = imageState.kind === 'image' ? imageState.next?.loadKey : undefined;
  const resolveLoadedNext = useCallback((loadKey: string) => {
    pendingHandoffCancelRef.current?.();
    pendingHandoffCancelRef.current = scheduleCanvasImageHandoffAfterPaint(() => {
      pendingHandoffCancelRef.current = undefined;
      imageState.resolveNext(loadKey);
    });
  }, [imageState]);
  const rejectLoadedNext = useCallback((loadKey: string) => {
    pendingHandoffCancelRef.current?.();
    pendingHandoffCancelRef.current = undefined;
    imageState.rejectNext(loadKey);
  }, [imageState]);

  useEffect(() => () => {
    pendingHandoffCancelRef.current?.();
    pendingHandoffCancelRef.current = undefined;
  }, [nextLoadKey, node.projectRelativePath]);

  useEffect(() => {
    const image = nextImageRef.current;
    if (!nextLoadKey || !image) {
      return undefined;
    }
    const resolve = () => resolveLoadedNext(nextLoadKey);
    const reject = () => rejectLoadedNext(nextLoadKey);
    const handled = syncCompletedCanvasImageHandoff({
      image,
      loadKey: nextLoadKey,
      resolveLoaded: resolveLoadedNext,
      rejectLoaded: rejectLoadedNext
    });
    if (handled) {
      return undefined;
    }
    image.addEventListener('load', resolve);
    image.addEventListener('error', reject);
    const frame = window.requestAnimationFrame(() => {
      syncCompletedCanvasImageHandoff({
        image,
        loadKey: nextLoadKey,
        resolveLoaded: resolveLoadedNext,
        rejectLoaded: rejectLoadedNext
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      image.removeEventListener('load', resolve);
      image.removeEventListener('error', reject);
    };
  }, [nextLoadKey, rejectLoadedNext, resolveLoadedNext]);

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
        {imageState.next ? (
          <img
            ref={nextImageRef}
            key={imageState.next.loadKey}
            data-canvas-image-layer="next"
            src={imageState.next.src}
            alt=""
            draggable={false}
            decoding="async"
            aria-hidden="true"
            onLoad={() => resolveLoadedNext(imageState.next!.loadKey)}
            onError={() => rejectLoadedNext(imageState.next!.loadKey)}
            style={{ objectFit: 'fill' }}
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

export function syncCompletedCanvasImageHandoff(input: {
  image: Pick<HTMLImageElement, 'complete' | 'naturalWidth'> | null;
  loadKey: string | undefined;
  resolveLoaded: (loadKey: string) => void;
  rejectLoaded: (loadKey: string) => void;
}): boolean {
  if (!input.loadKey || !input.image?.complete) {
    return false;
  }
  if (input.image.naturalWidth > 0) {
    input.resolveLoaded(input.loadKey);
  } else {
    input.rejectLoaded(input.loadKey);
  }
  return true;
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

function CanvasImagePlaceholder({
  node,
  onRetry
}: {
  node: ProjectedCanvasNode;
  onRetry?: (() => void) | undefined;
}): React.ReactElement {
  return (
    <div className="canvas-node-placeholder">
      <ImageIcon size={22} />
      <strong>Image</strong>
      <span>{node.projectRelativePath}</span>
      {onRetry ? (
        <button
          type="button"
          className="canvas-node-retry"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onRetry}
        >
          <RefreshCw size={12} />
          Retry
        </button>
      ) : null}
    </div>
  );
}

function CanvasTextNodeContent({
  node,
  buffer,
  problem,
  selected,
  actions,
  onSelectNode,
  onTitlePointerDown,
  onTitlePointerMove,
  onTitlePointerUp
}: {
  node: ProjectedCanvasNode;
  buffer: TextFileBuffer | undefined;
  problem: { title: string; message: string } | undefined;
  selected: boolean;
  actions: WorkbenchActions;
  onSelectNode: () => void;
  onTitlePointerDown: (event: React.PointerEvent<Element>) => void;
  onTitlePointerMove: (event: React.PointerEvent<Element>) => void;
  onTitlePointerUp: (event: React.PointerEvent<Element>) => void;
}): React.ReactElement {
  const status = textBufferStatus(buffer, problem);
  const selectSelf = () => {
    if (!selected) {
      onSelectNode();
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
