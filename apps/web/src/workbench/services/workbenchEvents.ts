import type { WorkbenchEvent, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';

export type SnapshotAffectingWorkbenchEvent = Extract<WorkbenchEvent, {
  type: 'project.changed' | 'project.fileChanged' | 'canvas.state.changed';
}>;

export function isSnapshotAffectingWorkbenchEvent(
  event: WorkbenchEvent
): event is SnapshotAffectingWorkbenchEvent {
  return event.type === 'project.changed'
    || event.type === 'project.fileChanged'
    || event.type === 'canvas.state.changed';
}

export function nextSnapshotFromWorkbenchEvent(
  event: SnapshotAffectingWorkbenchEvent,
  current: WorkbenchProjectSessionSnapshot | undefined
): WorkbenchProjectSessionSnapshot | undefined {
  if (event.type !== 'canvas.state.changed') {
    return event.snapshot;
  }
  if (!current || current.canvasWorkspace.status !== 'available') {
    throw new Error('Canvas State event cannot update an unavailable Canvas Workspace.');
  }
  const currentWorkspace = current.canvasWorkspace.workspace;
  const nodeStates = { ...currentWorkspace.nodeStates };
  for (const nodeChange of event.change.nodeStates) {
    if (nodeChange.state === null) {
      delete nodeStates[nodeChange.projectRelativePath];
    } else {
      nodeStates[nodeChange.projectRelativePath] = nodeChange.state;
    }
  }
  return {
    ...current,
    canvasWorkspace: {
      ...current.canvasWorkspace,
      workspace: {
        ...currentWorkspace,
        nodeStates,
        ...(event.change.occlusionOrder === undefined
          ? {}
          : { occlusionOrder: event.change.occlusionOrder })
      }
    }
  };
}
