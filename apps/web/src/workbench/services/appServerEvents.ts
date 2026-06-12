import type { WorkbenchEvent, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';

export function nextSnapshotFromAppServerEvent(
  event: WorkbenchEvent,
  current: WorkbenchProjectSessionSnapshot | undefined
): WorkbenchProjectSessionSnapshot | undefined {
  if (event.type === 'project.opened' || event.type === 'project.changed' || event.type === 'project.fileChanged') {
    return event.snapshot;
  }
  if (event.type === 'canvas.changed' && current) {
    return {
      ...current,
      canvases: current.canvases.map((canvas) => canvas.id === event.canvas.id ? event.canvas : canvas),
      projections: current.projections.map((projection) => projection.canvasId === event.projection.canvasId ? event.projection : projection)
    };
  }
  if (event.type === 'canvas.feedback.changed') {
    return current;
  }
  return current;
}
