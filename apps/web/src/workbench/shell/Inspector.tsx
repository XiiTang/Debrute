import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Loader2
} from '../ui/index.js';
import type { ProjectDiagnostic } from '@debrute/app-protocol';
import type { ModelArtifactProvenanceLookup } from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { EmptyState } from '../ui/index.js';
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
  selection,
  actions
}: {
  state: WorkbenchState;
  selection: CanvasSelection | undefined;
  actions: WorkbenchActions;
}): React.ReactElement {
  const i18n = useI18n();
  const context = getSelectionContext(state, selection);
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
        {context.node.nodeKind === 'file' ? <NodeModelArtifactSection node={context.node} actions={actions} i18n={i18n} /> : null}
      </>
    );
  }
  if (context.kind === 'nodes') {
    const fileCount = context.nodes.filter((node) => node.nodeKind === 'file').length;
    const directoryCount = context.nodes.length - fileCount;
    const manualLayoutCount = context.nodes.filter((node) => node.layoutMode === 'manual').length;
    const availabilityCounts = context.nodes.reduce<Record<string, number>>((current, node) => ({
      ...current,
      [node.availability.state]: (current[node.availability.state] ?? 0) + 1
    }), {});
    return (
      <div className="inspector-section">
        <h2>{i18n.t('inspector.selectedCount', { count: context.nodes.length })}</h2>
        <dl className="db-object-properties">
          <dt>{i18n.t('inspector.files')}</dt><dd>{fileCount}</dd>
          <dt>{i18n.t('inspector.directories')}</dt><dd>{directoryCount}</dd>
          {Object.entries(availabilityCounts).map(([state, count]) => (
            <React.Fragment key={state}>
              <dt>{availabilityStateLabel(state, i18n)}</dt>
              <dd>{count}</dd>
            </React.Fragment>
          ))}
          <dt>{i18n.t('inspector.manualLayout')}</dt><dd>{manualLayoutCount}</dd>
        </dl>
      </div>
    );
  }
  if (context.kind === 'diagnostic') {
    return (
      <div className="inspector-section">
        <h2>{context.diagnostic.code}</h2>
        <dl className="db-object-properties">
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

function availabilityStateLabel(state: string, i18n: WorkbenchI18n): string {
  switch (state) {
    case 'available': return i18n.t('inspector.available');
    case 'missing': return i18n.t('inspector.missing');
    case 'unreadable': return i18n.t('inspector.unreadable');
    default: return state;
  }
}

function selectedNodeRows(context: Extract<SelectionContext, { kind: 'node' }>, i18n: WorkbenchI18n): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    [i18n.t('inspector.type'), context.node.mediaKind ?? context.node.nodeKind],
    [i18n.t('inspector.position'), `${Math.round(context.node.x)}, ${Math.round(context.node.y)}`],
    [i18n.t('inspector.size'), `${Math.round(context.node.width)} x ${Math.round(context.node.height)}`]
  ];
  if (context.node.availability.state !== 'available' && context.node.availability.state !== 'directory') {
    rows.push([i18n.t('inspector.status'), nodeStatusLabel(context.node)]);
  }
  return rows;
}

type NodeModelArtifactState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; lookup: ModelArtifactProvenanceLookup }
  | { status: 'error'; message: string };

function NodeModelArtifactSection({
  node,
  actions,
  i18n
}: {
  node: Extract<SelectionContext, { kind: 'node' }>['node'];
  actions: WorkbenchActions;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const [state, setState] = useState<NodeModelArtifactState>({ status: 'idle' });
  const [open, setOpen] = useState(false);
  const lookupPathRef = useRef<string | undefined>(undefined);
  const lookupModelArtifactProvenance = actions.lookupModelArtifactProvenance;

  const load = useCallback(async () => {
    const lookupPath = node.projectRelativePath;
    lookupPathRef.current = lookupPath;
    setState({ status: 'loading' });
    try {
      const lookup = await lookupModelArtifactProvenance({ projectRelativePath: lookupPath });
      if (lookupPathRef.current === lookupPath) {
        setState({ status: 'loaded', lookup });
      }
    } catch (error) {
      if (lookupPathRef.current === lookupPath) {
        setState({ status: 'error', message: errorMessage(error) });
      }
    }
  }, [node.projectRelativePath, lookupModelArtifactProvenance]);

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
      {state.status === 'loaded' ? <ModelArtifactProvenanceView lookup={state.lookup} i18n={i18n} /> : null}
    </details>
  );
}

function ModelArtifactProvenanceView({ lookup, i18n }: { lookup: ModelArtifactProvenanceLookup; i18n: WorkbenchI18n }): React.ReactElement {
  if (!lookup.record) {
    return (
      <dl>
        <dt>SHA-256</dt><dd>{lookup.sha256}</dd>
        <dt>{i18n.t('inspector.match')}</dt><dd>{i18n.t('common.none')}</dd>
      </dl>
    );
  }
  const record = lookup.record;
  return (
    <div className="asset-ai-metadata-content">
      <dl>
        <dt>SHA-256</dt><dd>{lookup.sha256}</dd>
        <dt>{i18n.t('inspector.created')}</dt><dd>{record.createdAt}</dd>
      </dl>
      <JsonBlock title={i18n.t('inspector.request')} value={record.request} />
      <JsonBlock title={i18n.t('inspector.output')} value={record.response.output} />
      <JsonBlock title="Trace" value={record.response.trace} />
    </div>
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
  diagnostics: ProjectDiagnostic[];
  compact?: boolean;
  onSelect?: (diagnostic: ProjectDiagnostic) => void;
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
