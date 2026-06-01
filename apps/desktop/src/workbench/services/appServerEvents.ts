import type { AppServerEvent, ProjectSessionSnapshot } from '@axis/app-protocol';

export function nextSnapshotFromAppServerEvent(
  event: AppServerEvent,
  current: ProjectSessionSnapshot | undefined
): ProjectSessionSnapshot | undefined {
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
  return current;
}
