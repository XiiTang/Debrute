import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import {
  canvasManualLayoutDraftFromDragState,
  canvasNodesWithLayoutOverrides,
  type CanvasLayoutOverride,
  type CanvasManualLayoutDraft
} from '../canvasManualLayoutDraft';
import type { CanvasRuntimeDragState } from './CanvasEditorRuntime';

export interface CanvasManualLayoutPresentation {
  layoutOverrides: readonly CanvasLayoutOverride[];
}

export interface CanvasManualLayoutLifecycle {
  getPresentation(): CanvasManualLayoutPresentation;
  getPresentedNodes(): ProjectedCanvasNode[];
  setActiveDrag(dragState: CanvasRuntimeDragState | undefined): void;
  submitFinishedDrag(dragState: CanvasRuntimeDragState): Promise<void>;
  acceptProjection(projection: CanvasProjection): void;
  dispose(): void;
}

interface SubmittedManualLayoutDraft {
  id: number;
  draft: CanvasManualLayoutDraft;
}

export function createCanvasManualLayoutLifecycle(input: {
  canvasId: string;
  initialProjection: CanvasProjection;
  submitManualLayout(nodeLayouts: CanvasLayoutOverride[]): Promise<void>;
}): CanvasManualLayoutLifecycle {
  if (input.initialProjection.canvasId !== input.canvasId) {
    throw new Error(`Manual Layout lifecycle for ${input.canvasId} cannot start from Projection ${input.initialProjection.canvasId}.`);
  }
  let projection = input.initialProjection;
  let active: CanvasManualLayoutDraft | undefined;
  let submitted: SubmittedManualLayoutDraft[] = [];
  let nextSubmissionId = 1;
  let disposed = false;

  const draftFromDragState = (dragState: CanvasRuntimeDragState): CanvasManualLayoutDraft => (
    canvasManualLayoutDraftFromDragState({
      canvasId: input.canvasId,
      dragState,
      point: dragState.current ?? dragState.start
    })
  );

  const presentation = (): CanvasManualLayoutPresentation => {
    const merged = new Map<string, CanvasLayoutOverride>();
    for (const draft of [...submitted.map((submission) => submission.draft), active]) {
      if (!draft) {
        continue;
      }
      for (const layout of draft.nodeLayouts) {
        merged.set(layout.projectRelativePath, layout);
      }
    }
    return { layoutOverrides: [...merged.values()] };
  };

  return {
    getPresentation: presentation,
    getPresentedNodes() {
      return canvasNodesWithLayoutOverrides({
        nodes: projection.nodes,
        layoutOverrides: presentation().layoutOverrides
      });
    },
    setActiveDrag(dragState) {
      if (disposed) {
        return;
      }
      active = dragState ? draftFromDragState(dragState) : undefined;
    },
    async submitFinishedDrag(dragState) {
      if (disposed) {
        throw new Error(`Manual Layout lifecycle for ${input.canvasId} is disposed.`);
      }
      const draft = draftFromDragState(dragState);
      active = undefined;
      const currentNodePaths = new Set(projection.nodes.map((node) => node.projectRelativePath));
      if (
        draft.nodeLayouts.length === 0
        || draft.nodeLayouts.some((layout) => !currentNodePaths.has(layout.projectRelativePath))
      ) {
        return;
      }
      const submission = { id: nextSubmissionId++, draft };
      submitted.push(submission);
      try {
        await input.submitManualLayout([...draft.nodeLayouts]);
      } catch (error) {
        submitted = submitted.filter((candidate) => candidate.id !== submission.id);
        throw error;
      }
    },
    acceptProjection(nextProjection) {
      if (disposed) {
        return;
      }
      if (nextProjection.canvasId !== input.canvasId) {
        throw new Error(`Manual Layout lifecycle for ${input.canvasId} cannot accept Projection ${nextProjection.canvasId}.`);
      }
      projection = nextProjection;
      const nodesByPath = new Map(projection.nodes.map((node) => [node.projectRelativePath, node]));
      const confirmedSubmissionByPath = new Map<string, number>();
      for (let index = submitted.length - 1; index >= 0; index -= 1) {
        const submission = submitted[index]!;
        for (const layout of submission.draft.nodeLayouts) {
          if (confirmedSubmissionByPath.has(layout.projectRelativePath)) {
            continue;
          }
          const node = nodesByPath.get(layout.projectRelativePath);
          if (node && sameLayout(node, layout)) {
            confirmedSubmissionByPath.set(layout.projectRelativePath, submission.id);
          }
        }
      }
      submitted = submitted
        .map((submission) => ({
          ...submission,
          draft: {
            ...submission.draft,
            nodeLayouts: submission.draft.nodeLayouts.filter((layout) => {
              if (!nodesByPath.has(layout.projectRelativePath)) {
                return false;
              }
              const confirmedSubmissionId = confirmedSubmissionByPath.get(layout.projectRelativePath);
              return confirmedSubmissionId === undefined || submission.id > confirmedSubmissionId;
            })
          }
        }))
        .filter((submission) => submission.draft.nodeLayouts.length > 0);
    },
    dispose() {
      disposed = true;
      active = undefined;
      submitted = [];
    }
  };
}

function sameLayout(
  node: Pick<CanvasProjection['nodes'][number], 'x' | 'y' | 'width' | 'height'>,
  layout: CanvasLayoutOverride
): boolean {
  return node.x === layout.x
    && node.y === layout.y
    && node.width === layout.width
    && node.height === layout.height;
}
