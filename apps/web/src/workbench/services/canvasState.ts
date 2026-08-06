import type { CanvasWorkspaceCanvas, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { ProjectDiagnostic } from '@debrute/app-protocol';
import type { WorkbenchState } from '../../types';
import type { ProjectedCanvasNode } from '../canvas/CanvasScene.js';
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
    const projection = state.canvasProjection?.canvasId === activeCanvasId
      ? state.canvasProjection
      : undefined;
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

export function getCanvasById(snapshot: WorkbenchProjectSessionSnapshot | undefined, canvasId: string | undefined): CanvasWorkspaceCanvas | undefined {
  return canvasId && snapshot?.canvasWorkspace.status === 'available'
    ? snapshot.canvasWorkspace.workspace.canvases.find((canvas) => canvas.id === canvasId)
    : undefined;
}

export function nodeStatusLabel(node: ProjectedCanvasNode): string {
  if (node.availability.state === 'directory') {
    return 'directory';
  }
  if (node.availability.state === 'available') {
    return `${node.availability.mimeType} / ${node.availability.size} bytes`;
  }
  return `${node.availability.state}: ${node.availability.message}`;
}

export function projectRelativeSource(_snapshot: WorkbenchProjectSessionSnapshot | undefined, projectRelativePath: string): string {
  return projectRelativePath;
}
