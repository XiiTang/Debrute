import type {
  WorkbenchCanvasDocumentMutationResult
} from '@debrute/app-protocol';
import type {
  WorkbenchProjectProjection,
  WorkbenchTextViewportOverlayToken
} from './WorkbenchProjectProjection.js';

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
  overlayToken: WorkbenchTextViewportOverlayToken;
}

type CanvasTextViewportUpdateOutcome =
  | { status: 'ok' }
  | { status: 'error'; error: unknown };

export interface CanvasTextViewportStateController {
  update: (canvasId: string, input: CanvasTextViewportUpdateInput) => Promise<void>;
}

export function createCanvasTextViewportStateController(options: {
  projectProjection: WorkbenchProjectProjection;
  updateCanvasTextViewportState: (
    canvasId: string,
    input: CanvasTextViewportUpdateInput
  ) => Promise<WorkbenchCanvasDocumentMutationResult>;
}): CanvasTextViewportStateController {
  const pendingUpdates = new Map<string, PendingCanvasTextViewportUpdate>();
  const queuedUpdates = new Map<string, PendingCanvasTextViewportUpdate>();
  const outcomes = new Map<number, CanvasTextViewportUpdateOutcome>();
  let version = 0;
  let flushPromise: Promise<void> | undefined;

  const flushPendingUpdates = async (): Promise<void> => {
    const batch = takeNextCanvasTextViewportUpdateBatch(queuedUpdates);
    const currentState = options.projectProjection.getState();
    const batchGeneration = batch.pending[0]?.overlayToken.generation;
    if (currentState.status !== 'bound' || currentState.generation !== batchGeneration) {
      completeCanvasTextViewportUpdateBatch(batch.pending, pendingUpdates, outcomes);
      return;
    }
    try {
      await options.updateCanvasTextViewportState(batch.canvasId, {
        updates: batch.pending.map(canvasTextViewportUpdateInput)
      });
      completeCanvasTextViewportUpdateBatch(batch.pending, pendingUpdates, outcomes);
    } catch (error) {
      const currentState = options.projectProjection.getState();
      const generationIsCurrent = currentState.status !== 'unbound'
        && currentState.generation === batch.pending[0]?.overlayToken.generation;
      for (const sent of batch.pending) {
        const key = canvasTextViewportPendingUpdateKey(sent.canvasId, sent.projectRelativePath);
        if (pendingUpdates.get(key)?.version === sent.version) {
          pendingUpdates.delete(key);
        }
        if (generationIsCurrent) {
          outcomes.set(sent.version, { status: 'error', error });
          options.projectProjection.rejectTextViewport(sent.overlayToken);
        } else {
          outcomes.set(sent.version, { status: 'ok' });
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
    const submittedUpdates: PendingCanvasTextViewportUpdate[] = [];
    for (const update of input.updates) {
      const key = canvasTextViewportPendingUpdateKey(canvasId, update.projectRelativePath);
      const superseded = queuedUpdates.get(key);
      if (superseded) {
        outcomes.set(superseded.version, { status: 'ok' });
      }
      const pending: PendingCanvasTextViewportUpdate = {
        canvasId,
        projectRelativePath: update.projectRelativePath,
        scrollTop: update.scrollTop,
        scrollLeft: update.scrollLeft,
        version: version += 1,
        overlayToken: options.projectProjection.presentTextViewport({
          canvasId,
          ...update
        })
      };
      submittedUpdates.push(pending);
      pendingUpdates.set(key, pending);
      queuedUpdates.set(key, pending);
    }
    if (submittedUpdates.length === 0) {
      return;
    }
    try {
      for (;;) {
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
    update
  };
}

function completeCanvasTextViewportUpdateBatch(
  pending: PendingCanvasTextViewportUpdate[],
  pendingUpdates: Map<string, PendingCanvasTextViewportUpdate>,
  outcomes: Map<number, CanvasTextViewportUpdateOutcome>
): void {
  for (const sent of pending) {
    const key = canvasTextViewportPendingUpdateKey(sent.canvasId, sent.projectRelativePath);
    if (pendingUpdates.get(key)?.version === sent.version) {
      pendingUpdates.delete(key);
    }
    outcomes.set(sent.version, { status: 'ok' });
  }
}

function takeNextCanvasTextViewportUpdateBatch(
  queuedUpdates: Map<string, PendingCanvasTextViewportUpdate>
): { canvasId: string; pending: PendingCanvasTextViewportUpdate[] } {
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
  return { canvasId: first.canvasId, pending };
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
