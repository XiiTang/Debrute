import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { projectCanvas, type CanvasDocument, type CanvasNodeAvailability } from '@debrute/canvas-core';

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
  const availabilityByPath = new Map(
    currentProjection.nodes.map((node) => [node.projectRelativePath, node.availability])
  );
  const nextProjection = projectCanvas({
    canvas,
    diagnostics: currentProjection.diagnostics,
    nodeAvailability: (node): CanvasNodeAvailability => {
      const availability = availabilityByPath.get(node.projectRelativePath);
      if (!availability) {
        throw new Error(`Cannot apply Canvas document ${canvas.id} without availability for ${node.projectRelativePath}.`);
      }
      return availability;
    }
  });
  return {
    ...snapshot,
    canvases: snapshot.canvases.map((current) => current.id === canvas.id ? canvas : current),
    projections: snapshot.projections.map((projection) => (
      projection.canvasId === canvas.id ? nextProjection : projection
    ))
  };
}
