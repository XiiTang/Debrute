import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import type {
  ActivityMessage,
  ActivityRecord,
  ActivitySource,
  ActivityTaskStatus,
  CanvasActivityOperation,
  ExplorerActivityOperation,
  IntegrationActivityOperation,
  WorkbenchActivityOperation
} from '@debrute/app-protocol';
import { Button, Card, IconButton, X } from '../ui/index.js';
import { useI18n, type WorkbenchI18n } from '../i18n/index.js';
import {
  isActiveTask,
  isTerminalActivity,
  type WorkbenchActivities
} from '../services/WorkbenchActivities.js';

export interface WorkbenchActivitySurfacesProps {
  activities: WorkbenchActivities;
  activityBellRef: React.RefObject<HTMLButtonElement | null>;
  interactionBlocked: boolean;
}

interface ActivityAnchor {
  readonly right: number;
  readonly top: number;
}

export function WorkbenchActivitySurfaces({
  activities,
  activityBellRef,
  interactionBlocked
}: WorkbenchActivitySurfacesProps): React.ReactElement | null {
  const i18n = useI18n();
  const snapshot = useSyncExternalStore(
    activities.subscribe,
    activities.getSnapshot,
    activities.getSnapshot
  );
  const centerRef = useRef<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<ActivityAnchor>();
  const [now, setNow] = useState(Date.now());

  useLayoutEffect(() => {
    activities.setPresentationBlocked(interactionBlocked);
    return () => activities.setPresentationBlocked(false);
  }, [activities, interactionBlocked]);

  useLayoutEffect(() => {
    const bell = activityBellRef.current;
    if (!bell) return;
    const updateAnchor = () => {
      const bounds = bell.getBoundingClientRect();
      const next = {
        right: Math.max(8, window.innerWidth - bounds.right),
        top: bounds.bottom + 8
      };
      setAnchor((current) => current?.right === next.right && current.top === next.top
        ? current
        : next);
    };
    updateAnchor();
    window.addEventListener('resize', updateAnchor);
    const observer = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(updateAnchor);
    observer?.observe(bell);
    return () => {
      window.removeEventListener('resize', updateAnchor);
      observer?.disconnect();
    };
  });

  useEffect(() => {
    if (!snapshot.centerOpen && snapshot.floatingRecordIds.length === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [snapshot.centerOpen, snapshot.floatingRecordIds.length]);

  useEffect(() => {
    if (interactionBlocked) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (activities.getSnapshot().centerOpen) activities.closeCenter();
      else activities.hideFloating();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activities, interactionBlocked]);

  useEffect(() => {
    if (interactionBlocked || !snapshot.centerOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (centerRef.current?.contains(target)) return;
      if ((target as Element).closest?.('[data-workbench-activity-bell]')) return;
      activities.closeCenter();
    };
    window.addEventListener('pointerdown', handlePointerDown, { capture: true });
    return () => window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
  }, [activities, interactionBlocked, snapshot.centerOpen]);

  const floatingRecords = snapshot.floatingRecordIds
    .map((id) => snapshot.records.find((record) => record.id === id))
    .filter((record): record is ActivityRecord => record !== undefined);
  const activeRecords = snapshot.records
    .filter(isActiveTask)
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt));
  const recentRecords = snapshot.records
    .filter(isTerminalActivity)
    .sort((left, right) => activityTimestamp(right) - activityTimestamp(left));
  const positionStyle = {
    '--db-activity-anchor-right': `${anchor?.right ?? 8}px`,
    '--db-activity-anchor-top': `${anchor?.top ?? 36}px`
  } as React.CSSProperties;

  if (!snapshot.centerOpen && floatingRecords.length === 0) return null;

  return (
    <div className="db-activity-surfaces" style={positionStyle}>
      {!snapshot.centerOpen && floatingRecords.length > 0 ? (
        <div
          className="db-activity-floating-stack"
          data-activity-container="floating"
          role="region"
          aria-label={i18n.t('shell.activities.centerTitle')}
          aria-live="polite"
        >
          {floatingRecords.map((record) => (
            <ActivityCard key={record.id} record={record} activities={activities} now={now} />
          ))}
        </div>
      ) : null}
      {snapshot.centerOpen ? (
        <section
          id="workbench-activity-center"
          ref={centerRef}
          className="db-activity-center"
          data-activity-container="center"
          role="dialog"
          aria-label={i18n.t('shell.activities.centerTitle')}
        >
          <header className="db-activity-center__header">
            <h2>{i18n.t('shell.activities.centerTitle')}</h2>
            <div className="db-activity-center__actions">
              <Button
                size="xs"
                className="db-activity-center__clear"
                data-activity-clear-all
                disabled={recentRecords.length === 0}
                onClick={() => {
                  void activities.clearTerminal().catch(() => undefined);
                }}
              >
                {i18n.t('shell.activities.clearAll')}
              </Button>
              <IconButton
                size="xs"
                label={i18n.t('common.close')}
                icon={<X />}
                onClick={() => activities.closeCenter()}
              />
            </div>
          </header>
          <div className="db-activity-center__body">
            {snapshot.records.length === 0 ? (
              <p className="db-activity-center__empty">{i18n.t('shell.activities.empty')}</p>
            ) : (
              <>
                {activeRecords.length > 0 ? (
                  <ActivityGroup
                    title={i18n.t('shell.activities.activeGroup')}
                    records={activeRecords}
                    activities={activities}
                    now={now}
                  />
                ) : null}
                {recentRecords.length > 0 ? (
                  <ActivityGroup
                    title={i18n.t('shell.activities.recentGroup')}
                    records={recentRecords}
                    activities={activities}
                    now={now}
                  />
                ) : null}
              </>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ActivityGroup({
  title,
  records,
  activities,
  now
}: {
  title: string;
  records: readonly ActivityRecord[];
  activities: WorkbenchActivities;
  now: number;
}): React.ReactElement {
  return (
    <section className="db-activity-group">
      <h3>{title}</h3>
      <div className="db-activity-group__cards">
        {records.map((record) => (
          <ActivityCard key={record.id} record={record} activities={activities} now={now} />
        ))}
      </div>
    </section>
  );
}

function ActivityCard({
  record,
  activities,
  now
}: {
  record: ActivityRecord;
  activities: WorkbenchActivities;
  now: number;
}): React.ReactElement {
  const i18n = useI18n();
  const active = isActiveTask(record);
  const relativeTime = formatRelativeTime(i18n, active ? record.createdAt : record.updatedAt, now);
  return (
    <Card className={`db-activity-card db-activity-card--${record.type === 'task' ? record.status : 'notice'}`}>
      <div className="db-activity-card__heading">
        <p className="db-activity-card__metadata">
          <span className="db-activity-card__status">{statusLabel(i18n, record)}</span>
          <span aria-hidden="true"> · </span>
          <span>{sourceLabel(i18n, record.source)}</span>
          {record.project ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>{record.project.projectName}</span>
            </>
          ) : null}
        </p>
        <div className="db-activity-card__trailing">
          <time dateTime={active ? record.createdAt : record.updatedAt}>{relativeTime}</time>
          {!active ? (
            <IconButton
              className="db-activity-card__dismiss"
              size="xs"
              label={i18n.t('shell.activities.dismiss')}
              icon={<X />}
              onClick={() => {
                void activities.dismiss(record.id).catch(() => undefined);
              }}
            />
          ) : null}
        </div>
      </div>
      <p className="db-activity-card__message">{activityMessage(i18n, record)}</p>
      {active && record.type === 'task' ? (
        <ActivityProgressView record={record} i18n={i18n} />
      ) : null}
    </Card>
  );
}

function ActivityProgressView({
  record,
  i18n
}: {
  record: Extract<ActivityRecord, { type: 'task' }>;
  i18n: WorkbenchI18n;
}): React.ReactElement {
  if (record.progress.type === 'determinate') {
    const value = record.progress.total === 0
      ? 0
      : record.progress.completed / record.progress.total;
    return (
      <div className="db-activity-card__progress-row">
        <div
          className="db-activity-card__progress db-activity-card__progress--determinate"
          role="progressbar"
          aria-label={i18n.t('shell.activities.progress')}
          aria-valuemin={0}
          aria-valuemax={record.progress.total}
          aria-valuenow={record.progress.completed}
        >
          <span style={{ '--db-activity-progress': `${value * 100}%` } as React.CSSProperties} />
        </div>
        <span className="db-activity-card__progress-value">
          {record.progress.completed} / {record.progress.total}
        </span>
      </div>
    );
  }
  return (
    <div
      className="db-activity-card__progress db-activity-card__progress--indeterminate"
      role="progressbar"
      aria-label={i18n.t('shell.activities.progress')}
    >
      <span />
    </div>
  );
}

function statusLabel(i18n: WorkbenchI18n, record: ActivityRecord): string {
  if (record.type === 'notice') return i18n.t('shell.activities.status.notice');
  const keys: Record<ActivityTaskStatus, Parameters<WorkbenchI18n['t']>[0]> = {
    running: 'shell.activities.status.running',
    cancelling: 'shell.activities.status.cancelling',
    succeeded: 'shell.activities.status.succeeded',
    failed: 'shell.activities.status.failed',
    cancelled: 'shell.activities.status.cancelled'
  };
  return i18n.t(keys[record.status]);
}

function sourceLabel(i18n: WorkbenchI18n, source: ActivitySource): string {
  switch (source) {
    case 'project': return i18n.t('shell.activities.source.project');
    case 'canvas': return i18n.t('shell.activities.source.canvas');
    case 'explorer': return i18n.t('shell.activities.source.explorer');
    case 'model-request': return i18n.t('shell.activities.source.modelRequest');
    case 'photoshop': return i18n.t('shell.activities.source.photoshop');
    case 'workbench': return i18n.t('shell.activities.source.workbench');
    case 'update': return i18n.t('shell.activities.source.update');
    case 'integration': return i18n.t('shell.activities.source.integration');
  }
}

function activityMessage(i18n: WorkbenchI18n, record: ActivityRecord): string {
  const message = record.message;
  switch (message.kind) {
    case 'project-opened':
      return i18n.t('shell.activities.message.projectOpened', {
        project: record.project?.projectName ?? ''
      });
    case 'project-operation-failed':
      return i18n.t('shell.activities.message.projectOpenFailed');
    case 'canvas-operation-failed':
      return canvasMessage(i18n, message.operation);
    case 'explorer-operation-failed':
      return explorerMessage(i18n, message.operation);
    case 'workbench-operation-failed':
      return workbenchMessage(i18n, message.operation);
    case 'update-install-failed':
      return i18n.t('shell.activities.message.updateInstallFailed');
    case 'model-request':
      return modelRequestMessage(i18n, record, message);
    case 'photoshop-send':
      return taskMessage(i18n, record, 'photoshop', { path: message.projectRelativePath });
    case 'integration-operation':
      return taskMessage(i18n, record, 'integration', {
        integration: message.integrationId,
        operation: integrationOperationLabel(i18n, message.operation)
      });
  }
}

function canvasMessage(i18n: WorkbenchI18n, operation: CanvasActivityOperation): string {
  switch (operation) {
    case 'feedback-unavailable': return i18n.t('shell.activities.message.canvas.feedbackUnavailable');
    case 'feedback-save': return i18n.t('shell.activities.message.canvas.feedbackSaveFailed');
    case 'save-text-viewport': return i18n.t('shell.activities.message.canvas.saveTextViewportFailed');
    case 'save-layout': return i18n.t('shell.activities.message.canvas.saveLayoutFailed');
    case 'save-video-playback': return i18n.t('shell.activities.message.canvas.saveVideoPlaybackFailed');
    case 'set-directory-disclosure': return i18n.t('shell.activities.message.canvas.saveLayoutFailed');
    case 'reveal-path': return i18n.t('shell.activities.message.canvas.saveLayoutFailed');
    case 'raise-selection': return i18n.t('shell.activities.message.canvas.saveLayoutFailed');
    case 'create': return i18n.t('shell.activities.message.canvas.createFailed');
    case 'rename': return i18n.t('shell.activities.message.canvas.renameFailed');
    case 'delete': return i18n.t('shell.activities.message.canvas.deleteFailed');
    case 'reorder': return i18n.t('shell.activities.message.canvas.reorderFailed');
    case 'reset-auto-layout': return i18n.t('shell.activities.message.canvas.resetAutoLayoutFailed');
    case 'reset-layout': return i18n.t('shell.activities.message.canvas.resetLayoutFailed');
    case 'reset-workspace': return i18n.t('shell.activities.message.canvas.resetWorkspaceFailed');
    case 'copy-path': return i18n.t('shell.activities.message.canvas.copyPathFailed');
  }
}

function explorerMessage(i18n: WorkbenchI18n, operation: ExplorerActivityOperation): string {
  switch (operation) {
    case 'load-directory': return i18n.t('shell.activities.message.explorer.loadDirectoryFailed');
    case 'copy': return i18n.t('shell.activities.message.explorer.copyFailed');
    case 'move': return i18n.t('shell.activities.message.explorer.moveFailed');
    case 'import': return i18n.t('shell.activities.message.explorer.importFailed');
    case 'copy-path': return i18n.t('shell.activities.message.explorer.copyPathFailed');
    case 'reveal': return i18n.t('shell.activities.message.explorer.revealFailed');
    case 'delete': return i18n.t('shell.activities.message.explorer.deleteFailed');
    case 'paste': return i18n.t('shell.activities.message.explorer.pasteFailed');
  }
}

function workbenchMessage(i18n: WorkbenchI18n, operation: WorkbenchActivityOperation): string {
  switch (operation) {
    case 'window-state': return i18n.t('shell.activities.message.workbench.windowStateFailed');
    case 'window-command': return i18n.t('shell.activities.message.workbench.windowCommandFailed');
    case 'menu-command': return i18n.t('shell.activities.message.workbench.menuCommandFailed');
  }
}

function modelRequestMessage(
  i18n: WorkbenchI18n,
  record: ActivityRecord,
  message: Extract<ActivityMessage, { kind: 'model-request' }>
): string {
  return taskMessage(i18n, record, 'modelRequest', {
    count: message.itemCount,
    kind: modelKindLabel(i18n, message.modelKind)
  });
}

function taskMessage(
  i18n: WorkbenchI18n,
  record: ActivityRecord,
  family: 'modelRequest' | 'photoshop' | 'integration',
  params: Record<string, string | number>
): string {
  if (record.type !== 'task') return '';
  const key = `shell.activities.message.${family}.${record.status}` as Parameters<WorkbenchI18n['t']>[0];
  return i18n.t(key, params);
}

function modelKindLabel(
  i18n: WorkbenchI18n,
  kind: Extract<ActivityMessage, { kind: 'model-request' }>['modelKind']
): string {
  switch (kind) {
    case 'image': return i18n.t('shell.activities.modelKind.image');
    case 'video': return i18n.t('shell.activities.modelKind.video');
    case 'tts': return i18n.t('shell.activities.modelKind.tts');
    case 'music': return i18n.t('shell.activities.modelKind.music');
    case 'sound-effect': return i18n.t('shell.activities.modelKind.soundEffect');
  }
}

function integrationOperationLabel(
  i18n: WorkbenchI18n,
  operation: IntegrationActivityOperation
): string {
  switch (operation) {
    case 'install': return i18n.t('shell.activities.integrationOperation.install');
    case 'update': return i18n.t('shell.activities.integrationOperation.update');
    case 'uninstall': return i18n.t('shell.activities.integrationOperation.uninstall');
  }
}

function formatRelativeTime(i18n: WorkbenchI18n, iso: string, now: number): string {
  const elapsed = Math.max(0, now - timestamp(iso));
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return i18n.t('shell.activities.time.now');
  const formatter = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'always' });
  if (elapsed < 3_600_000) return formatter.format(-Math.floor(elapsed / 60_000), 'minute');
  if (elapsed < 86_400_000) return formatter.format(-Math.floor(elapsed / 3_600_000), 'hour');
  return formatter.format(-Math.floor(elapsed / 86_400_000), 'day');
}

function activityTimestamp(record: ActivityRecord): number {
  return timestamp(isActiveTask(record) ? record.createdAt : record.updatedAt);
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
