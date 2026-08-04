import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import {
  canvasManualLayoutDraftFromInteraction,
  canvasNodeStackOrder,
  canvasNodesWithLayoutOverrides,
  canvasStackOrderWithRaisedGroup,
  type CanvasLayoutOverride,
  type CanvasManualLayoutDraft,
  type CanvasNodeStackOrder
} from '../canvasManualLayoutDraft';
import type { CanvasRuntimeLayoutInteraction } from './CanvasEditorRuntime.js';

export interface CanvasManualLayoutPresentation {
  layoutOverrides: readonly CanvasLayoutOverride[];
  stackOrder: CanvasNodeStackOrder | undefined;
  raisedNodeProjectRelativePaths: readonly string[];
}

export interface CanvasManualLayoutLifecycle {
  getPresentation(): CanvasManualLayoutPresentation;
  setActiveInteraction(interaction: CanvasRuntimeLayoutInteraction | undefined): void;
  submitFinishedInteraction(interaction: CanvasRuntimeLayoutInteraction): Promise<void>;
  acceptProjection(projection: CanvasProjection): void;
  dispose(): void;
}

interface SubmittedManualLayoutDraft {
  id: number;
  draft: CanvasManualLayoutDraft;
  raisedNodeProjectRelativePaths: string[];
  expectedStackOrder: string[];
  stackPending: boolean;
}

export function createCanvasManualLayoutLifecycle(input: {
  canvasId: string;
  initialProjection: CanvasProjection;
  submitManualLayout(mutation: Pick<CanvasManualLayoutDraft, 'interaction' | 'nodeLayouts'>): Promise<void>;
}): CanvasManualLayoutLifecycle {
  if (input.initialProjection.canvasId !== input.canvasId) {
    throw new Error(`Manual Layout lifecycle for ${input.canvasId} cannot start from Projection ${input.initialProjection.canvasId}.`);
  }
  let projection = input.initialProjection;
  let active: CanvasManualLayoutDraft | undefined;
  let submitted: SubmittedManualLayoutDraft[] = [];
  let nextSubmissionId = 1;
  let disposed = false;
  let projectedStackOrder = canvasNodeStackOrder(projection.nodes);
  let activeStackCache: {
    base: readonly string[];
    raisedKey: string;
    value: string[];
  } | undefined;

  const rebasePendingStackOrders = () => {
    let order = projectedStackOrder;
    for (const submission of submitted) {
      if (!submission.stackPending) {
        continue;
      }
      order = canvasStackOrderWithRaisedGroup(order, submission.raisedNodeProjectRelativePaths);
      submission.expectedStackOrder = order;
    }
  };

  const confirmPendingStackOrders = (nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>) => {
    for (const submission of submitted) {
      if (submission.raisedNodeProjectRelativePaths.every((path) => !nodesByPath.has(path))) {
        submission.stackPending = false;
      }
    }
    const confirmedStackSubmission = [...submitted]
      .reverse()
      .find((submission) => (
        submission.stackPending
        && sameRelativeStackOrder(submission.expectedStackOrder, projectedStackOrder)
      ));
    if (!confirmedStackSubmission) {
      return;
    }
    for (const submission of submitted) {
      if (submission.id <= confirmedStackSubmission.id) {
        submission.stackPending = false;
      }
    }
  };

  const draftFromInteraction = (interaction: CanvasRuntimeLayoutInteraction): CanvasManualLayoutDraft => (
    canvasManualLayoutDraftFromInteraction({
      canvasId: input.canvasId,
      interaction,
      point: interaction.current ?? interaction.start
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
    const pendingStackOrder = [...submitted]
      .reverse()
      .find((submission) => submission.stackPending)
      ?.expectedStackOrder ?? projectedStackOrder;
    const activeRaisedPaths = active?.nodeLayouts.map((layout) => layout.projectRelativePath) ?? [];
    const activeRaisedKey = activeRaisedPaths.join('\u001f');
    let stackOrder = pendingStackOrder;
    if (activeRaisedPaths.length > 0) {
      if (activeStackCache?.base !== pendingStackOrder || activeStackCache.raisedKey !== activeRaisedKey) {
        activeStackCache = {
          base: pendingStackOrder,
          raisedKey: activeRaisedKey,
          value: canvasStackOrderWithRaisedGroup(pendingStackOrder, activeRaisedPaths)
        };
      }
      stackOrder = activeStackCache.value;
    }
    const raisedPaths = new Set([
      ...submitted.filter((submission) => submission.stackPending)
        .flatMap((submission) => submission.raisedNodeProjectRelativePaths),
      ...activeRaisedPaths
    ]);
    return {
      layoutOverrides: [...merged.values()],
      stackOrder: sameStackOrder(projectedStackOrder, stackOrder) ? undefined : stackOrder,
      raisedNodeProjectRelativePaths: stackOrder.filter((path) => raisedPaths.has(path))
    };
  };

  return {
    getPresentation: presentation,
    setActiveInteraction(interaction) {
      if (disposed) {
        return;
      }
      active = interaction ? draftFromInteraction(interaction) : undefined;
    },
    async submitFinishedInteraction(interaction) {
      if (disposed) {
        throw new Error(`Manual Layout lifecycle for ${input.canvasId} is disposed.`);
      }
      const draft = draftFromInteraction(interaction);
      active = undefined;
      const currentNodePaths = new Set(projection.nodes.map((node) => node.projectRelativePath));
      if (
        draft.nodeLayouts.length === 0
        || draft.nodeLayouts.some((layout) => !currentNodePaths.has(layout.projectRelativePath))
      ) {
        return;
      }
      const basePresentation = presentation();
      const baseNodes = canvasNodesWithLayoutOverrides({
        nodes: projection.nodes,
        layoutOverrides: basePresentation.layoutOverrides
      });
      const geometryChanged = draft.nodeLayouts.some((layout) => {
        const node = baseNodes.find((candidate) => candidate.projectRelativePath === layout.projectRelativePath);
        return !node || !sameLayout(node, layout);
      });
      const raisedNodeProjectRelativePaths = draft.nodeLayouts.map((layout) => layout.projectRelativePath);
      const baseStackOrder = basePresentation.stackOrder ?? canvasNodeStackOrder(projection.nodes);
      const expectedStackOrder = canvasStackOrderWithRaisedGroup(baseStackOrder, raisedNodeProjectRelativePaths);
      if (!geometryChanged && sameStackOrder(baseStackOrder, expectedStackOrder)) {
        return;
      }
      const submission = {
        id: nextSubmissionId++,
        draft,
        raisedNodeProjectRelativePaths,
        expectedStackOrder,
        stackPending: true
      };
      submitted.push(submission);
      try {
        await input.submitManualLayout({
          interaction: draft.interaction,
          nodeLayouts: [...draft.nodeLayouts]
        });
      } catch (error) {
        submitted = submitted.filter((candidate) => candidate.id !== submission.id);
        rebasePendingStackOrders();
        confirmPendingStackOrders(new Map(
          projection.nodes.map((node) => [node.projectRelativePath, node])
        ));
        submitted = submitted.filter((candidate) => (
          candidate.draft.nodeLayouts.length > 0 || candidate.stackPending
        ));
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
      projectedStackOrder = canvasNodeStackOrder(projection.nodes);
      activeStackCache = undefined;
      const nodesByPath = new Map(projection.nodes.map((node) => [node.projectRelativePath, node]));
      confirmPendingStackOrders(nodesByPath);
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
        .filter((submission) => submission.draft.nodeLayouts.length > 0 || submission.stackPending);
      rebasePendingStackOrders();
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

function sameStackOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function sameRelativeStackOrder(expected: readonly string[], actual: readonly string[]): boolean {
  const expectedPaths = new Set(expected);
  const actualPaths = new Set(actual);
  return sameStackOrder(
    expected.filter((path) => actualPaths.has(path)),
    actual.filter((path) => expectedPaths.has(path))
  );
}
