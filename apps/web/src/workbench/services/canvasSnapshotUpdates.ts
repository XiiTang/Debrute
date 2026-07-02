import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
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
