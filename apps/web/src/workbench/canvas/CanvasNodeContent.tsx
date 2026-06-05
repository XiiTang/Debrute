import React, { useEffect, useState } from 'react';
import { AlertTriangle, File, FileText, Folder, Image as ImageIcon, Maximize2, Music2, RefreshCw, Save, Video } from 'lucide-react';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { CanvasMonacoEditor } from './CanvasMonacoEditor';
import { useCanvasImageResource } from './CanvasImageResourceContext';

export interface CanvasNodeContentProps {
  node: ProjectedCanvasNode;
  selected: boolean;
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
  actions,
  textBuffer,
  onSelectNode,
  onTitlePointerDown,
  onTitlePointerMove,
  onTitlePointerUp
}: CanvasNodeContentProps): React.ReactElement {
  const [mediaError, setMediaError] = useState<string>();
  const [mediaRetryNonce, setMediaRetryNonce] = useState(0);
  const ensureTextFileBuffer = actions.ensureTextFileBuffer;
  const nodeRevision = node.availability.state === 'available' ? node.availability.revision : undefined;
  const mediaSrc = node.mediaKind === 'image'
    ? undefined
    : node.availability.state === 'available'
      ? node.availability.fileUrl
      : undefined;

  useEffect(() => {
    setMediaError(undefined);
    setMediaRetryNonce(0);
  }, [mediaSrc, node.mediaKind]);

  useEffect(() => {
    if (node.mediaKind !== 'text' || node.availability.state !== 'available') {
      return;
    }
    void ensureTextFileBuffer(node.projectRelativePath, nodeRevision);
  }, [node.mediaKind, node.projectRelativePath, nodeRevision, ensureTextFileBuffer]);

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
            <CanvasImageNodeContent node={node} />
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

function CanvasImageNodeContent({
  node
}: {
  node: ProjectedCanvasNode;
}): React.ReactElement {
  const imageState = useCanvasImageResource(node.projectRelativePath);
  if (imageState.kind === 'image') {
    return (
      <>
        {imageState.loaded ? (
          <img
            key={imageState.loaded.loadKey}
            src={imageState.loaded.src}
            alt={node.projectRelativePath}
            draggable={false}
            decoding="async"
            style={{ objectFit: 'fill' }}
          />
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
