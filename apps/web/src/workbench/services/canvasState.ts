import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type {
  CanvasDocument,
  Diagnostic,
  ProjectedCanvasNode
} from '@debrute/canvas-core';
import type { WorkbenchState } from '../../types';
import type { CanvasSelection, CanvasSelectionItem } from '../canvas/runtime/canvasSelection';

export type SelectionContext =
  | { kind: 'empty'; diagnostics: Diagnostic[] }
  | { kind: 'node'; canvasId: string; node: ProjectedCanvasNode; diagnostics: Diagnostic[] }
  | { kind: 'multi'; items: CanvasSelectionItem[]; diagnostics: Diagnostic[] }
  | { kind: 'diagnostic'; diagnostic: Diagnostic; diagnostics: Diagnostic[] };

export function getSelectionContext(
  state: WorkbenchState,
  selection: CanvasSelection | undefined,
  activeCanvasId: string | undefined
): SelectionContext {
  const snapshot = state.snapshot;
  if (!snapshot || !selection) {
    return { kind: 'empty', diagnostics: [] };
  }
  if (selection.kind === 'multi') {
    return { kind: 'multi', items: selection.items, diagnostics: [] };
  }
  if (selection.kind === 'node') {
    const projection = [
      ...snapshot.projections.filter((item) => item.canvasId === activeCanvasId),
      ...snapshot.projections.filter((item) => item.canvasId !== activeCanvasId)
    ].find((item) => item.nodes.some((node) => node.projectRelativePath === selection.projectRelativePath));
    const node = projection?.nodes.find((item) => item.projectRelativePath === selection.projectRelativePath);
    if (projection && node) {
      return { kind: 'node', canvasId: projection.canvasId, node, diagnostics: [] };
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
