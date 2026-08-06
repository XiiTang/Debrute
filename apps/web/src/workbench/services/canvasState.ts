import type { ProjectDiagnostic, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { WorkbenchState } from '../../types';
import type { ProjectedCanvasNode } from '../canvas/CanvasScene.js';
import type { CanvasSelection } from '../canvas/runtime/canvasSelection.js';

export type SelectionContext =
  | { kind: 'empty'; diagnostics: ProjectDiagnostic[] }
  | { kind: 'node'; node: ProjectedCanvasNode; diagnostics: ProjectDiagnostic[] }
  | { kind: 'nodes'; nodes: ProjectedCanvasNode[]; diagnostics: ProjectDiagnostic[] }
  | { kind: 'diagnostic'; diagnostic: ProjectDiagnostic; diagnostics: ProjectDiagnostic[] };

export function getSelectionContext(
  state: WorkbenchState,
  selection: CanvasSelection | undefined
): SelectionContext {
  const snapshot = state.snapshot;
  if (!snapshot || !selection) {
    return { kind: 'empty', diagnostics: [] };
  }
  if (selection.kind === 'nodes') {
    const projection = state.canvasProjection;
    const selectedPaths = new Set(selection.projectRelativePaths);
    const nodes = projection?.nodes.filter((node) => selectedPaths.has(node.projectRelativePath)) ?? [];
    if (projection && nodes.length === 1) {
      return { kind: 'node', node: nodes[0]!, diagnostics: [] };
    }
    if (projection && nodes.length > 1) {
      return { kind: 'nodes', nodes, diagnostics: [] };
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
