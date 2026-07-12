import type { WorkbenchEvent, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';

export type SnapshotAffectingWorkbenchEvent = Extract<WorkbenchEvent, {
  type: 'project.opened' | 'project.changed' | 'project.fileChanged' | 'canvas.changed';
}>;

export function isSnapshotAffectingWorkbenchEvent(
  event: WorkbenchEvent
): event is SnapshotAffectingWorkbenchEvent {
  return event.type === 'project.opened'
    || event.type === 'project.changed'
    || event.type === 'project.fileChanged'
    || event.type === 'canvas.changed';
}

export function nextSnapshotFromAppServerEvent(
  event: SnapshotAffectingWorkbenchEvent,
  current: WorkbenchProjectSessionSnapshot | undefined
): WorkbenchProjectSessionSnapshot | undefined {
  if (event.type === 'canvas.changed') {
    // The HTTP client scopes the event stream to the open project, so a Canvas
    // document event without a current snapshot is a programming error; it must
    // not fabricate a project state.
    if (!current) {
      return undefined;
    }
    return {
      ...current,
      canvases: current.canvases.map((canvas) => canvas.id === event.canvas.id ? event.canvas : canvas),
      projections: current.projections.map((projection) => projection.canvasId === event.projection.canvasId ? event.projection : projection)
    };
  }
  return event.snapshot;
}
