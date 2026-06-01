import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleDot,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Unlock
} from 'lucide-react';
import {
  canvasNodeLayerOrderTopFirst,
  type Diagnostic
} from '@axis/canvas-core';
import type { GeneratedAssetMetadataLookup, GeneratedAssetRecord } from '@axis/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import {
  getCanvasById,
  getSelectionContext,
  nodeStatusLabel,
  projectRelativeSource,
  type SelectionContext
} from '../services/canvasState';

export function Inspector({ state, activeCanvasId, actions }: { state: WorkbenchState; activeCanvasId: string | undefined; actions: WorkbenchActions }): React.ReactElement {
  const context = getSelectionContext(state, state.selection, activeCanvasId);
  const diagnostics = context.diagnostics.length > 0 ? context.diagnostics : state.snapshot?.diagnostics.slice(0, 5) ?? [];
  return (
    <aside className="inspector">
      <div className="inspector-title">
        <span>Inspector</span>
        <CircleDot size={15} />
      </div>
      <InspectorDetails context={context} state={state} actions={actions} />
      <div className="inspector-section">
        <h3>Diagnostics</h3>
        <DiagnosticList diagnostics={diagnostics} compact />
      </div>
    </aside>
  );
}

function InspectorDetails({
  context,
  state,
  actions
}: {
  context: SelectionContext;
  state: WorkbenchState;
  actions: WorkbenchActions;
}): React.ReactElement {
  const snapshot = state.snapshot;
  if (context.kind === 'node') {
    return (
      <>
        <div className="inspector-section">
          <h2>{context.node.projectRelativePath}</h2>
          <dl>
            <dt>Kind</dt><dd>{context.node.nodeKind}</dd>
            <dt>Media</dt><dd>{context.node.mediaKind ?? 'directory'}</dd>
            <dt>Path</dt><dd>{context.node.projectRelativePath}</dd>
            <dt>Position</dt><dd>{Math.round(context.node.x)}, {Math.round(context.node.y)}</dd>
            <dt>Size</dt><dd>{Math.round(context.node.width)} x {Math.round(context.node.height)}</dd>
            <dt>Layer</dt><dd>{context.node.z}</dd>
            <dt>Visible</dt><dd>{context.node.visible !== false ? 'yes' : 'no'}</dd>
            <dt>Locked</dt><dd>{context.node.locked === true ? 'yes' : 'no'}</dd>
            <dt>Status</dt><dd>{nodeStatusLabel(context.node)}</dd>
          </dl>
        </div>
        <NodeVisualControls context={context} state={state} actions={actions} />
        {context.node.nodeKind === 'file' ? <NodeGeneratedMetadataSection node={context.node} actions={actions} /> : null}
      </>
    );
  }
  if (context.kind === 'multi') {
    const counts = context.items.reduce<Record<string, number>>((current, item) => ({
      ...current,
      [item.kind]: (current[item.kind] ?? 0) + 1
    }), {});
    return (
      <div className="inspector-section">
        <h2>{context.items.length} selected</h2>
        <dl>
          {Object.entries(counts).map(([kind, count]) => (
            <React.Fragment key={kind}>
              <dt>{kind}</dt><dd>{count}</dd>
            </React.Fragment>
          ))}
        </dl>
      </div>
    );
  }
  if (context.kind === 'diagnostic') {
    return (
      <div className="inspector-section">
        <h2>{context.diagnostic.code}</h2>
        <dl>
          <dt>Source</dt><dd>{context.diagnostic.source}</dd>
          <dt>Severity</dt><dd>{context.diagnostic.severity}</dd>
          <dt>Entity</dt><dd>{context.diagnostic.entityId ?? 'project'}</dd>
          <dt>File</dt><dd>{context.diagnostic.filePath ? projectRelativeSource(snapshot, context.diagnostic.filePath) : 'none'}</dd>
        </dl>
      </div>
    );
  }
  return (
    <div className="inspector-empty">
      <CircleDot size={18} />
      <span>Select a node or diagnostic.</span>
    </div>
  );
}

function NodeVisualControls({
  context,
  state,
  actions
}: {
  context: Extract<SelectionContext, { kind: 'node' }>;
  state: WorkbenchState;
  actions: WorkbenchActions;
}): React.ReactElement {
  const canvas = getCanvasById(state.snapshot, context.canvasId);
  const nodePath = context.node.projectRelativePath;
  const layerOrderTopFirst = canvas ? canvasNodeLayerOrderTopFirst(canvas) : [];
  const layerIndex = layerOrderTopFirst.indexOf(nodePath);
  const canMoveLayer = Boolean(canvas) && !context.node.locked && layerIndex >= 0;
  const moveLayer = (direction: -1 | 1) => {
    if (!canvas || !canMoveLayer) {
      return;
    }
    const nextIndex = layerIndex + direction;
    if (nextIndex < 0 || nextIndex >= layerOrderTopFirst.length) {
      return;
    }
    const nextOrder = [...layerOrderTopFirst];
    [nextOrder[layerIndex], nextOrder[nextIndex]] = [nextOrder[nextIndex]!, nextOrder[layerIndex]!];
    void actions.updateCanvasNodeLayers(context.canvasId, {
      nodeProjectRelativePathsTopFirst: nextOrder
    });
  };

  return (
    <div className="inspector-section">
      <h3>Visual</h3>
      <div className="inspector-node-controls" aria-label="Node visual controls">
        <button
          type="button"
          aria-label="Toggle visibility"
          title="Toggle visibility"
          disabled={!canvas}
          onClick={() => void actions.updateCanvasNodeLayers(context.canvasId, {
            nodeLayers: [{ projectRelativePath: nodePath, visible: context.node.visible === false }]
          })}
        >
          {context.node.visible === false ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        <button
          type="button"
          aria-label="Toggle lock"
          title="Toggle lock"
          disabled={!canvas}
          onClick={() => void actions.updateCanvasNodeLayers(context.canvasId, {
            nodeLayers: [{ projectRelativePath: nodePath, locked: context.node.locked !== true }]
          })}
        >
          {context.node.locked ? <Lock size={14} /> : <Unlock size={14} />}
        </button>
        <button
          type="button"
          aria-label="Move forward"
          title="Move forward"
          disabled={!canMoveLayer || layerIndex === 0}
          onClick={() => moveLayer(-1)}
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button"
          aria-label="Move backward"
          title="Move backward"
          disabled={!canMoveLayer || layerIndex === layerOrderTopFirst.length - 1}
          onClick={() => moveLayer(1)}
        >
          <ArrowDown size={14} />
        </button>
      </div>
    </div>
  );
}

type NodeGeneratedMetadataState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; lookup: GeneratedAssetMetadataLookup }
  | { status: 'error'; message: string };

function NodeGeneratedMetadataSection({
  node,
  actions
}: {
  node: Extract<SelectionContext, { kind: 'node' }>['node'];
  actions: WorkbenchActions;
}): React.ReactElement {
  const [state, setState] = useState<NodeGeneratedMetadataState>({ status: 'idle' });
  const [open, setOpen] = useState(false);
  const lookupPathRef = useRef<string | undefined>(undefined);
  const lookupGeneratedAssetMetadata = actions.lookupGeneratedAssetMetadata;

  const load = useCallback(async () => {
    const lookupPath = node.projectRelativePath;
    lookupPathRef.current = lookupPath;
    setState({ status: 'loading' });
    try {
      const lookup = await lookupGeneratedAssetMetadata({ projectRelativePath: lookupPath });
      if (lookupPathRef.current === lookupPath) {
        setState({ status: 'loaded', lookup });
      }
    } catch (error) {
      if (lookupPathRef.current === lookupPath) {
        setState({ status: 'error', message: errorMessage(error) });
      }
    }
  }, [node.projectRelativePath, lookupGeneratedAssetMetadata]);

  useEffect(() => {
    lookupPathRef.current = undefined;
    if (!open) {
      setState({ status: 'idle' });
      return;
    }
    void load();
  }, [load, open]);

  return (
    <details
      className="inspector-section asset-ai-metadata"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary>AI Metadata</summary>
      {state.status === 'loading' ? <div className="empty-line"><Loader2 className="spin" size={14} />Loading</div> : null}
      {state.status === 'error' ? <div className="asset-ai-metadata-message error">{state.message}</div> : null}
      {state.status === 'loaded' ? <GeneratedAssetMetadataLookupView lookup={state.lookup} /> : null}
    </details>
  );
}

function GeneratedAssetMetadataLookupView({ lookup }: { lookup: GeneratedAssetMetadataLookup }): React.ReactElement {
  const diagnostics = lookup.diagnostics?.length
    ? <GeneratedAssetMetadataDiagnosticsView diagnostics={lookup.diagnostics} />
    : null;
  if (lookup.status === 'unavailable') {
    return (
      <>
        <div className="asset-ai-metadata-message">{lookup.message}</div>
        {diagnostics}
      </>
    );
  }
  if (lookup.status === 'unmatched') {
    return (
      <>
        <dl>
          <dt>SHA-256</dt><dd>{lookup.fingerprint.hash}</dd>
          <dt>Match</dt><dd>none</dd>
        </dl>
        {diagnostics}
      </>
    );
  }
  return (
    <>
      <MatchedGeneratedAssetMetadataView lookup={lookup} />
      {diagnostics}
    </>
  );
}

function MatchedGeneratedAssetMetadataView({
  lookup
}: {
  lookup: Extract<GeneratedAssetMetadataLookup, { status: 'matched' }>;
}): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => {
    setSelectedIndex(0);
  }, [lookup.fingerprint.hash, lookup.records.length]);
  const record = lookup.records[Math.min(selectedIndex, lookup.records.length - 1)]!;

  return (
    <div className="asset-ai-metadata-content">
      {lookup.records.length > 1 ? (
        <label className="asset-ai-metadata-picker">
          <span>Record</span>
          <select value={selectedIndex} onChange={(event) => setSelectedIndex(Number(event.currentTarget.value))}>
            {lookup.records.map((item, index) => (
              <option key={item.recordId} value={index}>{`${index + 1}. ${item.createdAt}`}</option>
            ))}
          </select>
        </label>
      ) : null}
      <GeneratedAssetMetadataRecordView record={record} fingerprint={lookup.fingerprint.hash} />
    </div>
  );
}

function GeneratedAssetMetadataRecordView({
  record,
  fingerprint
}: {
  record: GeneratedAssetRecord;
  fingerprint: string;
}): React.ReactElement {
  return (
    <>
      <dl>
        <dt>SHA-256</dt><dd>{fingerprint}</dd>
        <dt>Created</dt><dd>{record.createdAt}</dd>
      </dl>
      <JsonBlock title="Request" value={record.providerCall.request} />
      <JsonBlock title="Output" value={record.providerCall.output} />
    </>
  );
}

function GeneratedAssetMetadataDiagnosticsView({
  diagnostics
}: {
  diagnostics: NonNullable<GeneratedAssetMetadataLookup['diagnostics']>;
}): React.ReactElement {
  return (
    <section className="asset-ai-metadata-diagnostics">
      <h4>Diagnostics</h4>
      <ul>
        {diagnostics.map((diagnostic, index) => (
          <li key={`${diagnostic.code}:${diagnostic.recordId ?? index}`}>
            <strong>{diagnostic.code}</strong>
            <span>{diagnostic.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }): React.ReactElement {
  return (
    <section className="asset-ai-metadata-json">
      <h4>{title}</h4>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

export function DiagnosticList({
  diagnostics,
  compact = false,
  onSelect
}: {
  diagnostics: Diagnostic[];
  compact?: boolean;
  onSelect?: (diagnostic: Diagnostic) => void;
}): React.ReactElement {
  if (diagnostics.length === 0) {
    return <div className="empty-line"><CheckCircle2 size={15} />No diagnostics</div>;
  }
  return (
    <div className={compact ? 'diagnostics compact' : 'diagnostics'}>
      {diagnostics.map((diagnostic) => (
        <button
          type="button"
          className={`diagnostic ${diagnostic.severity}`}
          key={diagnostic.id}
          onClick={() => onSelect?.(diagnostic)}
          disabled={!onSelect}
        >
          <AlertTriangle size={14} />
          <span>{diagnostic.message}</span>
          <small>{diagnostic.filePath ? `${diagnostic.filePath} / ${diagnostic.code}` : diagnostic.code}</small>
        </button>
      ))}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
