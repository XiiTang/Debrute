import React, { useEffect, useRef, useState } from 'react';
import type {
  ModelArtifactProvenanceLookup,
  ProjectPathInspection
} from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { EmptyState, Loader2 } from '../ui/index';
import { useI18n, type WorkbenchI18n } from '../i18n';
import { readBrowserMediaMetadata, type BrowserMediaMetadata } from './browserMediaMetadata';
import type { InspectionTargetSnapshot } from './inspectionTarget';

interface KeyedValue<T> {
  key: string;
  value: T;
}

export function Inspector({
  target,
  state,
  actions
}: {
  target: InspectionTargetSnapshot;
  state: WorkbenchState;
  actions: WorkbenchActions;
}): React.ReactElement {
  const i18n = useI18n();
  if (target.target.kind === 'empty') {
    return (
      <aside className="inspector">
        <EmptyState className="inspector-empty" title={i18n.t('inspector.selectPathOrNode')} />
      </aside>
    );
  }
  if (target.target.kind === 'multiple') {
    return (
      <aside className="inspector">
        <div className="inspector-section">
          <h2>{i18n.t('inspector.selectedCount', { count: target.target.count })}</h2>
        </div>
      </aside>
    );
  }
  return (
    <SinglePathInspector
      path={target.target.projectRelativePath}
      targetVersion={target.version}
      state={state}
      actions={actions}
      i18n={i18n}
    />
  );
}

function SinglePathInspector({
  path,
  targetVersion,
  state,
  actions,
  i18n
}: {
  path: string;
  targetVersion: number;
  state: WorkbenchState;
  actions: WorkbenchActions;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const requestKey = `${targetVersion}:${path}`;
  const [loadedInspection, setLoadedInspection] = useState<KeyedValue<ProjectPathInspection>>();
  const inspection = loadedInspection?.key === requestKey ? loadedInspection.value : undefined;
  const snapshotKind = state.snapshot?.projectTree.find(
    (entry) => entry.projectRelativePath === path
  )?.kind;
  const kind = inspection?.kind ?? snapshotKind ?? (path === '' ? 'directory' : 'file');
  const title = path === ''
    ? state.snapshot?.health.projectName ?? '/'
    : path.split('/').at(-1) ?? path;

  useEffect(() => {
    const controller = new AbortController();
    void actions.inspectProjectPath({ projectRelativePath: path }, controller.signal)
      .then((value) => setLoadedInspection({ key: requestKey, value }))
      .catch(() => undefined);
    return () => controller.abort();
  }, [actions.inspectProjectPath, path, requestKey]);

  return (
    <aside className="inspector">
      <div className="inspector-section">
        <h2>{title}</h2>
        <h3>{i18n.t(kind === 'directory'
          ? 'inspector.folderInformation'
          : 'inspector.fileInformation')}</h3>
        <InspectionProperties
          kind={kind}
          path={path}
          inspection={inspection}
          actions={actions}
          requestKey={requestKey}
          i18n={i18n}
        />
      </div>
      {kind === 'file' ? (
        <ModelArtifactSection
          path={path}
          requestKey={requestKey}
          actions={actions}
          i18n={i18n}
        />
      ) : null}
    </aside>
  );
}

function InspectionProperties({
  kind,
  path,
  inspection,
  actions,
  requestKey,
  i18n
}: {
  kind: 'file' | 'directory';
  path: string;
  inspection: ProjectPathInspection | undefined;
  actions: WorkbenchActions;
  requestKey: string;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const [loadedMedia, setLoadedMedia] = useState<KeyedValue<BrowserMediaMetadata>>();
  const media = loadedMedia?.key === requestKey ? loadedMedia.value : undefined;
  const fileInspection = inspection?.kind === 'file' ? inspection : undefined;
  const sourceMedia = fileInspection?.media.kind === 'video' || fileInspection?.media.kind === 'audio'
    ? fileInspection.media
    : undefined;

  useEffect(() => {
    if (!sourceMedia) {
      return;
    }
    const controller = new AbortController();
    void actions.resolveProjectFileSource({
      projectRelativePath: path,
      sourceToken: sourceMedia.sourceToken
    }, controller.signal).then((source) => (
      readBrowserMediaMetadata(sourceMedia.kind, source.fileUrl, controller.signal)
    )).then((value) => setLoadedMedia({ key: requestKey, value }))
      .catch(() => undefined);
    return () => controller.abort();
  }, [actions.resolveProjectFileSource, path, requestKey, sourceMedia]);

  const rows: Array<[string, string | undefined]> = [
    [i18n.t('inspector.path'), path || '/'],
    ...(kind === 'file' ? [
      [i18n.t('inspector.size'), fileInspection
        ? formatFileSize(fileInspection.sizeBytes, i18n.locale)
        : undefined],
      [i18n.t('inspector.format'), fileFormat(path)]
    ] satisfies Array<[string, string | undefined]> : []),
    [i18n.t('inspector.created'), inspection?.createdAtMs === undefined
      ? undefined
      : formatDate(inspection.createdAtMs, i18n.locale)],
    [i18n.t('inspector.modified'), inspection?.modifiedAtMs === undefined
      ? undefined
      : formatDate(inspection.modifiedAtMs, i18n.locale)],
    ...(kind === 'file' ? [
      [i18n.t('inspector.dimensions'), dimensions(fileInspection, media)],
      [i18n.t('inspector.duration'), media?.durationSeconds === undefined
        ? undefined
        : formatDuration(media.durationSeconds)]
    ] satisfies Array<[string, string | undefined]> : [])
  ];
  return (
    <dl className="db-object-properties">
      {rows.flatMap(([label, value]) => value === undefined ? [] : [
        <React.Fragment key={label}>
          <dt>{label}</dt><dd>{value}</dd>
        </React.Fragment>
      ])}
    </dl>
  );
}

function ModelArtifactSection({
  path,
  requestKey,
  actions,
  i18n
}: {
  path: string;
  requestKey: string;
  actions: WorkbenchActions;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [loadingKey, setLoadingKey] = useState<string>();
  const [loaded, setLoaded] = useState<KeyedValue<ModelArtifactProvenanceLookup>>();
  const requestGeneration = useRef(0);
  const lookup = loaded?.key === requestKey ? loaded.value : undefined;

  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    const generation = ++requestGeneration.current;
    setLoadingKey(requestKey);
    void actions.lookupModelArtifactProvenance({ projectRelativePath: path }, controller.signal)
      .then((value) => {
        if (requestGeneration.current === generation && !controller.signal.aborted) {
          setLoaded({ key: requestKey, value });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (requestGeneration.current === generation) {
          setLoadingKey((current) => current === requestKey ? undefined : current);
        }
      });
    return () => {
      requestGeneration.current += 1;
      controller.abort();
    };
  }, [actions.lookupModelArtifactProvenance, open, path, requestKey]);

  return (
    <details
      className="inspector-section asset-ai-metadata"
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (!nextOpen) {
          requestGeneration.current += 1;
          setLoaded(undefined);
          setLoadingKey(undefined);
        }
      }}
    >
      <summary>{i18n.t('inspector.aiGenerationRecord')}</summary>
      {loadingKey === requestKey && !lookup ? (
        <div className="empty-line"><Loader2 className="spin" size={14} />{i18n.t('inspector.loading')}</div>
      ) : null}
      {lookup ? <ModelArtifactProvenanceView lookup={lookup} i18n={i18n} /> : null}
    </details>
  );
}

function ModelArtifactProvenanceView({
  lookup,
  i18n
}: {
  lookup: ModelArtifactProvenanceLookup;
  i18n: WorkbenchI18n;
}): React.ReactElement | null {
  if (!lookup.record) {
    return null;
  }
  return (
    <div className="asset-ai-metadata-content">
      <dl>
        <dt>SHA-256</dt><dd>{lookup.sha256}</dd>
        <dt>{i18n.t('inspector.created')}</dt><dd>{lookup.record.createdAt}</dd>
      </dl>
      <JsonBlock title={i18n.t('inspector.request')} value={lookup.record.request} />
      <JsonBlock title={i18n.t('inspector.output')} value={lookup.record.response.output} />
      <JsonBlock title="Trace" value={lookup.record.response.trace} />
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

function dimensions(
  inspection: Extract<ProjectPathInspection, { kind: 'file' }> | undefined,
  media: BrowserMediaMetadata | undefined
): string | undefined {
  const value = inspection?.media.kind === 'image'
    ? inspection.media.dimensions
    : media?.dimensions;
  return value ? `${value.width} × ${value.height} px` : undefined;
}

function fileFormat(path: string): string | undefined {
  const name = path.split('/').at(-1) ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLocaleUpperCase() : undefined;
}

function formatFileSize(sizeBytes: number, locale: string): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = sizeBytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const human = unit === 0 ? `${value} B` : `${value.toFixed(2)} ${units[unit]}`;
  return `${human} (${sizeBytes.toLocaleString(locale)} bytes)`;
}

function formatDate(timestampMs: number, locale: string): string {
  return new Date(timestampMs).toLocaleString(locale);
}

function formatDuration(durationSeconds: number): string {
  const totalSeconds = Math.max(0, Math.round(durationSeconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}
