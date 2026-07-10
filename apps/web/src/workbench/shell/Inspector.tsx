import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2
} from 'lucide-react';
import type { Diagnostic } from '@debrute/canvas-core';
import type { GeneratedAssetMetadataLookup, GeneratedAssetRecord } from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { EmptyState, Select } from '../ui';
import type { CanvasSelection } from '../canvas/runtime/canvasSelection';
import {
  getSelectionContext,
  nodeStatusLabel,
  projectRelativeSource,
  type SelectionContext
} from '../services/canvasState';
import { useI18n, type WorkbenchI18n } from '../i18n';

export function Inspector({
  state,
  activeCanvasId,
  selection,
  actions
}: {
  state: WorkbenchState;
  activeCanvasId: string | undefined;
  selection: CanvasSelection | undefined;
  actions: WorkbenchActions;
}): React.ReactElement {
  const i18n = useI18n();
  const context = getSelectionContext(state, selection, activeCanvasId);
  const diagnostics = context.diagnostics.length > 0 ? context.diagnostics : state.snapshot?.diagnostics.slice(0, 5) ?? [];
  return (
    <aside className="inspector">
      <InspectorDetails context={context} state={state} actions={actions} i18n={i18n} />
      <div className="inspector-section">
        <h3>{i18n.t('inspector.diagnostics')}</h3>
        <DiagnosticList diagnostics={diagnostics} compact />
      </div>
    </aside>
  );
}

function InspectorDetails({
  context,
  state,
  actions,
  i18n
}: {
  context: SelectionContext;
  state: WorkbenchState;
  actions: WorkbenchActions;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const snapshot = state.snapshot;
  if (context.kind === 'node') {
    return (
      <>
        <div className="inspector-section">
          <h2>{context.node.projectRelativePath}</h2>
          <dl className="db-object-properties">
            {selectedNodeRows(context, i18n).map(([label, value]) => (
              <React.Fragment key={label}>
                <dt>{label}</dt><dd>{value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </div>
        {context.node.nodeKind === 'file' ? <NodeGeneratedMetadataSection node={context.node} actions={actions} i18n={i18n} /> : null}
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
        <h2>{i18n.t('inspector.selectedCount', { count: context.items.length })}</h2>
        <dl className="db-object-properties">
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
        <dl className="db-object-properties">
          <dt>{i18n.t('inspector.source')}</dt><dd>{context.diagnostic.source}</dd>
          <dt>{i18n.t('inspector.severity')}</dt><dd>{context.diagnostic.severity}</dd>
          <dt>{i18n.t('inspector.entity')}</dt><dd>{context.diagnostic.entityId ?? 'project'}</dd>
          <dt>{i18n.t('inspector.file')}</dt><dd>{context.diagnostic.filePath ? projectRelativeSource(snapshot, context.diagnostic.filePath) : i18n.t('common.none')}</dd>
        </dl>
      </div>
    );
  }
  return (
    <EmptyState className="inspector-empty" title={i18n.t('inspector.selectNodeOrDiagnostic')} />
  );
}

function selectedNodeRows(context: Extract<SelectionContext, { kind: 'node' }>, i18n: WorkbenchI18n): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    [i18n.t('inspector.type'), context.node.mediaKind ?? context.node.nodeKind],
    [i18n.t('inspector.position'), `${Math.round(context.node.x)}, ${Math.round(context.node.y)}`],
    [i18n.t('inspector.size'), `${Math.round(context.node.width)} x ${Math.round(context.node.height)}`]
  ];
  if (context.node.availability.state !== 'available') {
    rows.push([i18n.t('inspector.status'), nodeStatusLabel(context.node)]);
  }
  return rows;
}

type NodeGeneratedMetadataState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; lookup: GeneratedAssetMetadataLookup }
  | { status: 'error'; message: string };

function NodeGeneratedMetadataSection({
  node,
  actions,
  i18n
}: {
  node: Extract<SelectionContext, { kind: 'node' }>['node'];
  actions: WorkbenchActions;
  i18n: WorkbenchI18n;
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
      <summary>{i18n.t('inspector.aiMetadata')}</summary>
      {state.status === 'loading' ? <div className="empty-line"><Loader2 className="spin" size={14} />{i18n.t('inspector.loading')}</div> : null}
      {state.status === 'error' ? <div className="asset-ai-metadata-message error">{state.message}</div> : null}
      {state.status === 'loaded' ? <GeneratedAssetMetadataLookupView lookup={state.lookup} i18n={i18n} /> : null}
    </details>
  );
}

function GeneratedAssetMetadataLookupView({ lookup, i18n }: { lookup: GeneratedAssetMetadataLookup; i18n: WorkbenchI18n }): React.ReactElement {
  const diagnostics = lookup.diagnostics?.length
    ? <GeneratedAssetMetadataDiagnosticsView diagnostics={lookup.diagnostics} i18n={i18n} />
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
          <dt>{i18n.t('inspector.match')}</dt><dd>{i18n.t('common.none')}</dd>
        </dl>
        {diagnostics}
      </>
    );
  }
  return (
    <>
      <MatchedGeneratedAssetMetadataView lookup={lookup} i18n={i18n} />
      {diagnostics}
    </>
  );
}

function MatchedGeneratedAssetMetadataView({
  lookup,
  i18n
}: {
  lookup: Extract<GeneratedAssetMetadataLookup, { status: 'matched' }>;
  i18n: WorkbenchI18n;
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
          <span>{i18n.t('inspector.record')}</span>
          <Select className="asset-ai-metadata-select" value={selectedIndex} onChange={(event) => setSelectedIndex(Number(event.currentTarget.value))}>
            {lookup.records.map((item, index) => (
              <option key={item.recordId} value={index}>{`${index + 1}. ${item.createdAt}`}</option>
            ))}
          </Select>
        </label>
      ) : null}
      <GeneratedAssetMetadataRecordView record={record} fingerprint={lookup.fingerprint.hash} i18n={i18n} />
    </div>
  );
}

function GeneratedAssetMetadataRecordView({
  record,
  fingerprint,
  i18n
}: {
  record: GeneratedAssetRecord;
  fingerprint: string;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  return (
    <>
      <dl>
        <dt>SHA-256</dt><dd>{fingerprint}</dd>
        <dt>{i18n.t('inspector.created')}</dt><dd>{record.createdAt}</dd>
      </dl>
      <JsonBlock title={i18n.t('inspector.request')} value={record.modelRun.request} />
      <JsonBlock title={i18n.t('inspector.output')} value={record.modelRun.output} />
    </>
  );
}

function GeneratedAssetMetadataDiagnosticsView({
  diagnostics,
  i18n
}: {
  diagnostics: NonNullable<GeneratedAssetMetadataLookup['diagnostics']>;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  return (
    <section className="asset-ai-metadata-diagnostics">
      <h4>{i18n.t('inspector.diagnostics')}</h4>
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
  const i18n = useI18n();
  if (diagnostics.length === 0) {
    return <EmptyState className="empty-line" title={i18n.t('inspector.noDiagnostics')} />;
  }
  return (
    <div className={compact ? 'db-diagnostic-list db-diagnostic-list--compact' : 'db-diagnostic-list'}>
      {diagnostics.map((diagnostic) => (
        <button
          type="button"
          className={`db-diagnostic-row db-diagnostic-row--${diagnostic.severity}`}
          key={diagnostic.id}
          onClick={() => onSelect?.(diagnostic)}
          disabled={!onSelect}
        >
          <AlertTriangle size={14} />
          <span className="db-diagnostic-row__message">{diagnostic.message}</span>
          <small className="db-diagnostic-row__source">{diagnostic.filePath ? `${diagnostic.filePath} / ${diagnostic.code}` : diagnostic.code}</small>
        </button>
      ))}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
