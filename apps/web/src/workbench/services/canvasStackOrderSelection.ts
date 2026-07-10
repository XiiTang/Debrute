import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { CanvasSelection } from '../canvas/runtime/canvasSelection';
import { getCanvasById, selectedCanvasNodeNeedsStackOrderUpdate } from './canvasState';

export interface CanvasSelectionStackOrderSync {
  syncSelectedNode(): Promise<void>;
}

export interface CanvasSelectionStackOrderSyncOptions {
  getSnapshot(): WorkbenchProjectSessionSnapshot | undefined;
  getActiveCanvasId(): string | undefined;
  getSelection(): CanvasSelection | undefined;
  bringCanvasNodeToFront(
    canvasId: string,
    input: { projectRelativePath: string }
  ): Promise<void>;
}

export function createCanvasSelectionStackOrderSync(
  options: CanvasSelectionStackOrderSyncOptions
): CanvasSelectionStackOrderSync {
  let inFlight: Promise<void> | undefined;
  let pendingSelectionChange = false;

  const nextRequest = (): { canvasId: string; projectRelativePath: string } | undefined => {
    const canvasId = options.getActiveCanvasId();
    const selection = options.getSelection();
    const canvas = getCanvasById(options.getSnapshot(), canvasId);
    if (!canvasId || selection?.kind !== 'node' || !selectedCanvasNodeNeedsStackOrderUpdate(canvas, selection)) {
      return undefined;
    }
    return {
      canvasId,
      projectRelativePath: selection.projectRelativePath
    };
  };

  const flush = async (): Promise<void> => {
    while (true) {
      pendingSelectionChange = false;
      const request = nextRequest();
      if (!request) {
        return;
      }
      await options.bringCanvasNodeToFront(request.canvasId, {
        projectRelativePath: request.projectRelativePath
      });
      if (!pendingSelectionChange) {
        return;
      }
    }
  };

  return {
    syncSelectedNode: async () => {
      if (inFlight) {
        pendingSelectionChange = true;
        return inFlight;
      }
      inFlight = flush().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    }
  };
}
