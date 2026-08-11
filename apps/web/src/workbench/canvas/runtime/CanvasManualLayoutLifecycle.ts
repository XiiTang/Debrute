import type { CanvasProjection } from '../CanvasScene';
import {
  canvasManualLayoutDraftFromInteraction,
  canvasNodesWithLayoutOverrides,
  type CanvasLayoutOverride,
  type CanvasManualLayoutDraft
} from '../canvasManualLayoutDraft';
import type { CanvasRuntimeLayoutInteraction } from './CanvasEditorRuntime';

export interface CanvasManualLayoutPresentation {
  layoutOverrides: readonly CanvasLayoutOverride[];
}

export interface CanvasManualLayoutLifecycle {
  getPresentation(): CanvasManualLayoutPresentation;
  setActiveInteraction(interaction: CanvasRuntimeLayoutInteraction | undefined): void;
  submitFinishedInteraction(interaction: CanvasRuntimeLayoutInteraction): Promise<void>;
  acceptProjection(projection: CanvasProjection): void;
  acceptNodes(nodes: readonly CanvasProjection['nodes'][number][]): void;
  dispose(): void;
}

interface SubmittedManualLayoutDraft {
  id: number;
  draft: CanvasManualLayoutDraft;
}

export function createCanvasManualLayoutLifecycle(input: {
  initialProjection: CanvasProjection;
  submitManualLayout(mutation: Pick<CanvasManualLayoutDraft, 'nodeLayouts'>): Promise<void>;
}): CanvasManualLayoutLifecycle {
  let projection = input.initialProjection;
  let active: CanvasManualLayoutDraft | undefined;
  let submitted: SubmittedManualLayoutDraft[] = [];
  let nextSubmissionId = 1;
  let disposed = false;

  const draftFromInteraction = (interaction: CanvasRuntimeLayoutInteraction): CanvasManualLayoutDraft => (
    canvasManualLayoutDraftFromInteraction({
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
    return { layoutOverrides: [...merged.values()] };
  };

  const reconcileSubmittedPaths = (
    nodesByPath: ReadonlyMap<string, CanvasProjection['nodes'][number]>,
    touchedPaths: ReadonlySet<string>
  ) => {
    const confirmedSubmissionByPath = new Map<string, number>();
    for (let index = submitted.length - 1; index >= 0; index -= 1) {
      const submission = submitted[index]!;
      for (const layout of submission.draft.nodeLayouts) {
        if (!touchedPaths.has(layout.projectRelativePath)
          || confirmedSubmissionByPath.has(layout.projectRelativePath)
        ) {
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
            if (!touchedPaths.has(layout.projectRelativePath)) {
              return true;
            }
            if (!nodesByPath.has(layout.projectRelativePath)) {
              return false;
            }
            const confirmedSubmissionId = confirmedSubmissionByPath.get(layout.projectRelativePath);
            return confirmedSubmissionId === undefined || submission.id > confirmedSubmissionId;
          })
        }
      }))
      .filter((submission) => submission.draft.nodeLayouts.length > 0);
  };

  return {
    getPresentation: presentation,
    setActiveInteraction(interaction) {
      if (!disposed) {
        active = interaction ? draftFromInteraction(interaction) : undefined;
      }
    },
    async submitFinishedInteraction(interaction) {
      if (disposed) {
        throw new Error('Manual Layout lifecycle is disposed.');
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
      const presentedNodes = canvasNodesWithLayoutOverrides({
        nodes: projection.nodes,
        layoutOverrides: presentation().layoutOverrides
      });
      const geometryChanged = draft.nodeLayouts.some((layout) => {
        const node = presentedNodes.find((candidate) => candidate.projectRelativePath === layout.projectRelativePath);
        return !node || !sameLayout(node, layout);
      });
      if (!geometryChanged) {
        await input.submitManualLayout({
          nodeLayouts: []
        });
        return;
      }
      const submission = { id: nextSubmissionId++, draft };
      submitted.push(submission);
      try {
        await input.submitManualLayout({
          nodeLayouts: [...draft.nodeLayouts]
        });
      } catch (error) {
        submitted = submitted.filter((candidate) => candidate.id !== submission.id);
        throw error;
      }
    },
    acceptProjection(nextProjection) {
      if (disposed) {
        return;
      }
      projection = nextProjection;
      const nodesByPath = new Map(projection.nodes.map((node) => [node.projectRelativePath, node]));
      reconcileSubmittedPaths(nodesByPath, new Set([
        ...projection.nodes.map((node) => node.projectRelativePath),
        ...submitted.flatMap((submission) => submission.draft.nodeLayouts.map((layout) => layout.projectRelativePath))
      ]));
    },
    acceptNodes(nodes) {
      if (disposed || nodes.length === 0) {
        return;
      }
      const updates = new Map(nodes.map((node) => [node.projectRelativePath, node]));
      projection = {
        ...projection,
        nodes: projection.nodes.map((node) => updates.get(node.projectRelativePath) ?? node)
      };
      reconcileSubmittedPaths(
        new Map(nodes.map((node) => [node.projectRelativePath, node])),
        new Set(updates.keys())
      );
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
