import type {
  WorkbenchCanvasDocumentMutationResult,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import type { CanvasTextViewportState } from '@debrute/canvas-core';

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
  version: number;
  scope: number;
}

type CanvasTextViewportUpdateOutcome =
  | { status: 'ok' }
  | { status: 'error'; error: unknown };

export interface CanvasTextViewportStateController {
  reconcileSnapshot: (
    snapshot: WorkbenchProjectSessionSnapshot | undefined
  ) => WorkbenchProjectSessionSnapshot | undefined;
  reset: () => void;
  update: (canvasId: string, input: CanvasTextViewportUpdateInput) => Promise<void>;
}

export function createCanvasTextViewportStateController(options: {
  getAuthoritativeSnapshot: () => WorkbenchProjectSessionSnapshot | undefined;
  commitAuthoritativeSnapshot: (
    snapshot: WorkbenchProjectSessionSnapshot,
    projectRevision: number
  ) => boolean;
  commitPresentedSnapshot: (snapshot: WorkbenchProjectSessionSnapshot) => void;
  updateCanvasTextViewportState: (
    canvasId: string,
    input: CanvasTextViewportUpdateInput
  ) => Promise<WorkbenchCanvasDocumentMutationResult>;
}): CanvasTextViewportStateController {
  const pendingUpdates = new Map<string, PendingCanvasTextViewportUpdate>();
  const queuedUpdates = new Map<string, PendingCanvasTextViewportUpdate>();
  const outcomes = new Map<number, CanvasTextViewportUpdateOutcome>();
  let version = 0;
  let scope = 0;
  let flushPromise: Promise<void> | undefined;

  const reconcileSnapshot = (
    snapshot: WorkbenchProjectSessionSnapshot | undefined
  ): WorkbenchProjectSessionSnapshot | undefined => snapshot
    ? applyCanvasTextViewportOverlays(snapshot, pendingUpdates.values())
    : undefined;

  const flushPendingUpdates = async (): Promise<void> => {
    const batch = takeNextCanvasTextViewportUpdateBatch(queuedUpdates);
    try {
      const result = await options.updateCanvasTextViewportState(batch.canvasId, {
        updates: batch.pending.map(canvasTextViewportUpdateInput)
      });
      if (batch.scope !== scope) {
        return;
      }
      const current = options.getAuthoritativeSnapshot();
      if (!current) {
        throw new Error(`Cannot apply Canvas document ${result.canvas.id} without a current snapshot.`);
      }
      const confirmedSnapshot = applyConfirmedCanvasTextViewports(current, result, batch.pending);
      for (const sent of batch.pending) {
        const key = canvasTextViewportPendingUpdateKey(sent.canvasId, sent.projectRelativePath);
        const pending = pendingUpdates.get(key);
        if (pending?.version === sent.version) {
          pendingUpdates.delete(key);
        }
        outcomes.set(sent.version, { status: 'ok' });
      }
      if (!options.commitAuthoritativeSnapshot(confirmedSnapshot, result.projectRevision)) {
        const latest = options.getAuthoritativeSnapshot();
        if (latest) {
          options.commitPresentedSnapshot(reconcileSnapshot(latest) as WorkbenchProjectSessionSnapshot);
        }
      }
    } catch (error) {
      if (batch.scope !== scope) {
        return;
      }
      const current = options.getAuthoritativeSnapshot();
      if (current) {
        for (const sent of batch.pending) {
          outcomes.set(sent.version, { status: 'error', error });
          const key = canvasTextViewportPendingUpdateKey(sent.canvasId, sent.projectRelativePath);
          if (pendingUpdates.get(key)?.version !== sent.version) {
            continue;
          }
          pendingUpdates.delete(key);
        }
        options.commitPresentedSnapshot(reconcileSnapshot(current) as WorkbenchProjectSessionSnapshot);
      } else {
        for (const sent of batch.pending) {
          outcomes.set(sent.version, { status: 'error', error });
        }
      }
    }
  };

  const ensureFlush = (): Promise<void> => {
    if (!flushPromise) {
      flushPromise = flushPendingUpdates().finally(() => {
        flushPromise = undefined;
      });
    }
    return flushPromise;
  };

  const update = async (canvasId: string, input: CanvasTextViewportUpdateInput): Promise<void> => {
    const updateScope = scope;
    const current = options.getAuthoritativeSnapshot();
    if (!current) {
      throw new Error(`Cannot apply Canvas document ${canvasId} without a current snapshot.`);
    }
    const submittedUpdates: PendingCanvasTextViewportUpdate[] = [];
    for (const update of input.updates) {
      const key = canvasTextViewportPendingUpdateKey(canvasId, update.projectRelativePath);
      const superseded = queuedUpdates.get(key);
      if (superseded) {
        outcomes.set(superseded.version, { status: 'ok' });
      }
      const pending = {
        canvasId,
        projectRelativePath: update.projectRelativePath,
        scrollTop: update.scrollTop,
        scrollLeft: update.scrollLeft,
        version: version += 1,
        scope: updateScope
      };
      submittedUpdates.push(pending);
      pendingUpdates.set(key, pending);
      queuedUpdates.set(key, pending);
    }
    if (submittedUpdates.length === 0) {
      return;
    }
    options.commitPresentedSnapshot(reconcileSnapshot(current) as WorkbenchProjectSessionSnapshot);
    try {
      for (;;) {
        if (scope !== updateScope) {
          return;
        }
        const submittedOutcomes = submittedUpdates.map((update) => outcomes.get(update.version));
        const failure = submittedOutcomes.find(
          (outcome): outcome is Extract<CanvasTextViewportUpdateOutcome, { status: 'error' }> => (
            outcome?.status === 'error'
          )
        );
        if (failure) {
          throw failure.error;
        }
        if (submittedOutcomes.every((outcome) => outcome?.status === 'ok')) {
          return;
        }
        await ensureFlush();
      }
    } finally {
      for (const update of submittedUpdates) {
        outcomes.delete(update.version);
      }
    }
  };

  return {
    reconcileSnapshot,
    reset() {
      scope += 1;
      pendingUpdates.clear();
      queuedUpdates.clear();
      outcomes.clear();
    },
    update
  };
}

function takeNextCanvasTextViewportUpdateBatch(
  queuedUpdates: Map<string, PendingCanvasTextViewportUpdate>
): { canvasId: string; scope: number; pending: PendingCanvasTextViewportUpdate[] } {
  const first = queuedUpdates.values().next().value;
  if (!first) {
    throw new Error('Cannot take a Canvas text viewport batch from an empty queue.');
  }
  const pending = [...queuedUpdates.entries()]
    .filter(([, update]) => update.canvasId === first.canvasId)
    .map(([key, update]) => {
      queuedUpdates.delete(key);
      return update;
    });
  return { canvasId: first.canvasId, scope: first.scope, pending };
}

function applyCanvasTextViewportOverlays(
  snapshot: WorkbenchProjectSessionSnapshot,
  updates: Iterable<Pick<PendingCanvasTextViewportUpdate, 'canvasId' | 'projectRelativePath' | 'scrollTop' | 'scrollLeft'>>
): WorkbenchProjectSessionSnapshot {
  const byKey = new Map<string, CanvasTextViewportState>();
  for (const update of updates) {
    byKey.set(canvasTextViewportPendingUpdateKey(update.canvasId, update.projectRelativePath), {
      scrollTop: update.scrollTop,
      scrollLeft: update.scrollLeft
    });
  }
  if (byKey.size === 0) {
    return snapshot;
  }
  return applyCanvasTextViewportValues(snapshot, byKey);
}

function applyConfirmedCanvasTextViewports(
  snapshot: WorkbenchProjectSessionSnapshot,
  result: WorkbenchCanvasDocumentMutationResult,
  updates: PendingCanvasTextViewportUpdate[]
): WorkbenchProjectSessionSnapshot {
  const confirmed = new Map<string, CanvasTextViewportState | undefined>();
  for (const update of updates) {
    const node = result.canvas.nodeElements.find(
      (candidate) => candidate.projectRelativePath === update.projectRelativePath
    );
    if (node) {
      confirmed.set(
        canvasTextViewportPendingUpdateKey(update.canvasId, update.projectRelativePath),
        node.textViewport
      );
    }
  }
  return applyCanvasTextViewportValues(snapshot, confirmed);
}

function applyCanvasTextViewportValues(
  snapshot: WorkbenchProjectSessionSnapshot,
  byKey: Map<string, CanvasTextViewportState | undefined>
): WorkbenchProjectSessionSnapshot {
  return {
    ...snapshot,
    canvases: snapshot.canvases.map((canvas) => ({
      ...canvas,
      nodeElements: canvas.nodeElements.map((node) => applyCanvasTextViewportOverlay(
        node,
        byKey.has(canvasTextViewportPendingUpdateKey(canvas.id, node.projectRelativePath)),
        byKey.get(canvasTextViewportPendingUpdateKey(canvas.id, node.projectRelativePath))
      ))
    })),
    projections: snapshot.projections.map((projection) => ({
      ...projection,
      nodes: projection.nodes.map((node) => applyCanvasTextViewportOverlay(
        node,
        byKey.has(canvasTextViewportPendingUpdateKey(projection.canvasId, node.projectRelativePath)),
        byKey.get(canvasTextViewportPendingUpdateKey(projection.canvasId, node.projectRelativePath))
      ))
    }))
  };
}

function applyCanvasTextViewportOverlay<T extends { textViewport?: CanvasTextViewportState | undefined }>(
  node: T,
  hasViewport: boolean,
  viewport: CanvasTextViewportState | undefined
): T {
  if (!hasViewport) {
    return node;
  }
  if (viewport) {
    return { ...node, textViewport: viewport };
  }
  const { textViewport: _textViewport, ...withoutViewport } = node;
  return withoutViewport as T;
}

function canvasTextViewportUpdateInput(
  update: PendingCanvasTextViewportUpdate
): CanvasTextViewportUpdateInput['updates'][number] {
  return {
    projectRelativePath: update.projectRelativePath,
    scrollTop: update.scrollTop,
    scrollLeft: update.scrollLeft
  };
}

function canvasTextViewportPendingUpdateKey(canvasId: string, projectRelativePath: string): string {
  return `${canvasId}\u001f${projectRelativePath}`;
}
