import type {
  WorkbenchCanvasDocumentMutationResult,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import {
  projectCanvas,
  updateCanvasTextViewportState,
  type CanvasDocument,
  type CanvasNodeAvailability
} from '@debrute/canvas-core';

export function applyCanvasDocumentToWorkbenchSnapshot(
  snapshot: WorkbenchProjectSessionSnapshot,
  canvas: CanvasDocument
): WorkbenchProjectSessionSnapshot {
  if (!snapshot.canvases.some((current) => current.id === canvas.id)) {
    throw new Error(`Cannot apply Canvas document ${canvas.id} without a current canvas.`);
  }
  const currentProjection = snapshot.projections.find((projection) => projection.canvasId === canvas.id);
  if (!currentProjection) {
    throw new Error(`Cannot apply Canvas document ${canvas.id} without a current projection.`);
  }
  const projectionNodeByPath = new Map(
    currentProjection.nodes.map((node) => [node.projectRelativePath, node])
  );
  const projected = projectCanvas({
    canvas,
    diagnostics: currentProjection.diagnostics,
    nodeAvailability: (node): CanvasNodeAvailability => {
      const projectedNode = projectionNodeByPath.get(node.projectRelativePath);
      if (!projectedNode) {
        throw new Error(`Cannot apply Canvas document ${canvas.id} without availability for ${node.projectRelativePath}.`);
      }
      return projectedNode.availability;
    }
  });
  const nextProjection = {
    ...projected,
    nodes: projected.nodes.map((node) => {
      if (node.mediaKind !== 'video' || node.availability.state !== 'available') {
        return node;
      }
      const projectedNode = projectionNodeByPath.get(node.projectRelativePath);
      if (!projectedNode?.videoPresentation) {
        throw new Error(`Cannot apply Canvas document ${canvas.id} without video presentation for ${node.projectRelativePath}.`);
      }
      return {
        ...node,
        videoPresentation: projectedNode.videoPresentation
      };
    })
  };
  return {
    ...snapshot,
    canvases: snapshot.canvases.map((current) => current.id === canvas.id ? canvas : current),
    projections: snapshot.projections.map((projection) => (
      projection.canvasId === canvas.id ? nextProjection : projection
    ))
  };
}

export function applyCanvasMutationResultToWorkbenchSnapshot(
  snapshot: WorkbenchProjectSessionSnapshot,
  result: Pick<WorkbenchCanvasDocumentMutationResult, 'canvas' | 'projection'>
): WorkbenchProjectSessionSnapshot {
  return {
    ...snapshot,
    canvases: snapshot.canvases.map((canvas) => canvas.id === result.canvas.id ? result.canvas : canvas),
    projections: snapshot.projections.map((projection) => (
      projection.canvasId === result.projection.canvasId ? result.projection : projection
    ))
  };
}

export function applyCanvasTextViewportStateToWorkbenchSnapshot(
  snapshot: WorkbenchProjectSessionSnapshot,
  canvasId: string,
  input: {
    updates: Array<{
      projectRelativePath: string;
      scrollTop: number;
      scrollLeft: number;
    }>;
  }
): WorkbenchProjectSessionSnapshot {
  const canvas = snapshot.canvases.find((current) => current.id === canvasId);
  if (!canvas) {
    throw new Error(`Cannot apply Canvas document ${canvasId} without a current canvas.`);
  }
  const nextCanvas = updateCanvasTextViewportState(canvas, input);
  return nextCanvas === canvas
    ? snapshot
    : applyCanvasDocumentToWorkbenchSnapshot(snapshot, nextCanvas);
}

type CanvasTextViewportUpdateInput = {
  updates: Array<{
    projectRelativePath: string;
    scrollTop: number;
    scrollLeft: number;
  }>;
};

interface PendingCanvasTextViewportUpdate {
  canvasId: string;
  projectRelativePath: string;
  scrollTop: number;
  scrollLeft: number;
}

export function createCanvasTextViewportStateUpdater(options: {
  getSnapshot: () => WorkbenchProjectSessionSnapshot | undefined;
  commitSnapshot: (snapshot: WorkbenchProjectSessionSnapshot) => void;
  updateCanvasTextViewportState: (
    canvasId: string,
    input: CanvasTextViewportUpdateInput
  ) => Promise<WorkbenchCanvasDocumentMutationResult>;
}): (canvasId: string, input: CanvasTextViewportUpdateInput) => Promise<void> {
  const pendingUpdates = new Map<string, PendingCanvasTextViewportUpdate>();
  let flushPromise: Promise<void> | undefined;

  const flushPendingUpdates = async (): Promise<void> => {
    while (pendingUpdates.size > 0) {
      const batches = takeCanvasTextViewportUpdateBatches(pendingUpdates);
      for (const batch of batches) {
        const result = await options.updateCanvasTextViewportState(batch.canvasId, {
          updates: batch.updates
        });
        const current = options.getSnapshot();
        if (!current) {
          throw new Error(`Cannot apply Canvas document ${result.canvas.id} without a current snapshot.`);
        }
        const next = applyPendingCanvasTextViewportUpdates(
          applyCanvasMutationResultToWorkbenchSnapshot(current, result),
          pendingUpdates
        );
        options.commitSnapshot(next);
      }
    }
  };

  const ensureFlush = (): Promise<void> => {
    if (!flushPromise) {
      flushPromise = flushPendingUpdates().finally(() => {
        flushPromise = undefined;
        return pendingUpdates.size > 0 ? ensureFlush() : undefined;
      });
    }
    return flushPromise;
  };

  return async (canvasId, input) => {
    const current = options.getSnapshot();
    if (!current) {
      throw new Error(`Cannot apply Canvas document ${canvasId} without a current snapshot.`);
    }
    const local = applyCanvasTextViewportStateToWorkbenchSnapshot(current, canvasId, input);
    if (local === current) {
      return;
    }
    options.commitSnapshot(local);
    for (const update of input.updates) {
      pendingUpdates.set(canvasTextViewportPendingUpdateKey(canvasId, update.projectRelativePath), {
        canvasId,
        projectRelativePath: update.projectRelativePath,
        scrollTop: update.scrollTop,
        scrollLeft: update.scrollLeft
      });
    }
    await ensureFlush();
  };
}

function takeCanvasTextViewportUpdateBatches(
  pendingUpdates: Map<string, PendingCanvasTextViewportUpdate>
): Array<{ canvasId: string; updates: CanvasTextViewportUpdateInput['updates'] }> {
  const updates = [...pendingUpdates.values()];
  pendingUpdates.clear();
  return canvasTextViewportUpdateBatches(updates);
}

function applyPendingCanvasTextViewportUpdates(
  snapshot: WorkbenchProjectSessionSnapshot,
  pendingUpdates: Map<string, PendingCanvasTextViewportUpdate>
): WorkbenchProjectSessionSnapshot {
  let next = snapshot;
  for (const batch of canvasTextViewportUpdateBatches([...pendingUpdates.values()])) {
    next = applyCanvasTextViewportStateToWorkbenchSnapshot(next, batch.canvasId, {
      updates: batch.updates
    });
  }
  return next;
}

function canvasTextViewportUpdateBatches(
  updates: PendingCanvasTextViewportUpdate[]
): Array<{ canvasId: string; updates: CanvasTextViewportUpdateInput['updates'] }> {
  const updatesByCanvasId = new Map<string, CanvasTextViewportUpdateInput['updates']>();
  for (const update of updates) {
    const batch = updatesByCanvasId.get(update.canvasId) ?? [];
    batch.push({
      projectRelativePath: update.projectRelativePath,
      scrollTop: update.scrollTop,
      scrollLeft: update.scrollLeft
    });
    updatesByCanvasId.set(update.canvasId, batch);
  }
  return [...updatesByCanvasId].map(([canvasId, batch]) => ({ canvasId, updates: batch }));
}

function canvasTextViewportPendingUpdateKey(canvasId: string, projectRelativePath: string): string {
  return `${canvasId}\u001f${projectRelativePath}`;
}
