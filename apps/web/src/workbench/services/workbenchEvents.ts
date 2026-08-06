import type { WorkbenchEvent, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';

export type SnapshotAffectingWorkbenchEvent = Extract<WorkbenchEvent, {
  type: 'project.changed' | 'project.fileChanged';
}>;

export function isSnapshotAffectingWorkbenchEvent(
  event: WorkbenchEvent
): event is SnapshotAffectingWorkbenchEvent {
  return event.type === 'project.changed'
    || event.type === 'project.fileChanged';
}

export function nextSnapshotFromWorkbenchEvent(
  event: SnapshotAffectingWorkbenchEvent,
  _current: WorkbenchProjectSessionSnapshot | undefined
): WorkbenchProjectSessionSnapshot | undefined {
  return event.snapshot;
}
