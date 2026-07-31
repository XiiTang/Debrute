import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import {
  type CanvasDocument,
  type ProjectDiagnostic,
  type ProjectedCanvasNode
} from '@debrute/canvas-core';
import type { WorkbenchState } from '../../types';
import type { CanvasSelection } from '../canvas/runtime/canvasSelection.js';

export type SelectionContext =
  | { kind: 'empty'; diagnostics: ProjectDiagnostic[] }
  | { kind: 'node'; canvasId: string; node: ProjectedCanvasNode; diagnostics: ProjectDiagnostic[] }
  | { kind: 'nodes'; canvasId: string; nodes: ProjectedCanvasNode[]; diagnostics: ProjectDiagnostic[] }
  | { kind: 'diagnostic'; diagnostic: ProjectDiagnostic; diagnostics: ProjectDiagnostic[] };

export function getSelectionContext(
  state: WorkbenchState,
  selection: CanvasSelection | undefined,
  activeCanvasId: string | undefined
): SelectionContext {
  const snapshot = state.snapshot;
  if (!snapshot || !selection) {
    return { kind: 'empty', diagnostics: [] };
  }
  if (selection.kind === 'nodes') {
    const projection = snapshot.projections.find((item) => item.canvasId === activeCanvasId);
    const selectedPaths = new Set(selection.projectRelativePaths);
    const nodes = projection?.nodes.filter((node) => selectedPaths.has(node.projectRelativePath)) ?? [];
    if (projection && nodes.length === 1) {
      return { kind: 'node', canvasId: projection.canvasId, node: nodes[0]!, diagnostics: [] };
    }
    if (projection && nodes.length > 1) {
      return { kind: 'nodes', canvasId: projection.canvasId, nodes, diagnostics: [] };
    }
  }
  if (selection.kind === 'diagnostic') {
    const diagnostic = snapshot.diagnostics.find((item) => item.id === selection.id);
    if (diagnostic) {
      return { kind: 'diagnostic', diagnostic, diagnostics: [diagnostic] };
    }
  }
  return { kind: 'empty', diagnostics: [] };
}

export function getCanvasById(snapshot: WorkbenchProjectSessionSnapshot | undefined, canvasId: string | undefined): CanvasDocument | undefined {
  return canvasId ? snapshot?.canvases.find((canvas) => canvas.id === canvasId) : undefined;
}

export function nodeStatusLabel(node: ProjectedCanvasNode): string {
  if (node.availability.state === 'available') {
    return `${node.availability.mimeType} / ${node.availability.size} bytes`;
  }
  return `${node.availability.state}: ${node.availability.message}`;
}

export function projectRelativeSource(_snapshot: WorkbenchProjectSessionSnapshot | undefined, projectRelativePath: string): string {
  return projectRelativePath;
}
