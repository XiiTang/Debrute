import type { CanvasFeedbackDocument, UpdateCanvasFeedbackEntryInput } from '@debrute/canvas-core';

export function createCanvasFeedbackEntryUpdater(options: {
  requestUpdate: (input: UpdateCanvasFeedbackEntryInput) => Promise<CanvasFeedbackDocument>;
  applyFeedback: (feedback: CanvasFeedbackDocument) => void;
  notifyUnavailable: (message: string) => void;
}): (input: UpdateCanvasFeedbackEntryInput) => Promise<boolean> {
  let latestRequestId = 0;
  return async (input) => {
    const requestId = latestRequestId + 1;
    latestRequestId = requestId;
    try {
      const feedback = await options.requestUpdate(input);
      if (requestId === latestRequestId) {
        options.applyFeedback(feedback);
        return true;
      }
      return false;
    } catch (error) {
      if (requestId === latestRequestId) {
        options.notifyUnavailable(`Canvas feedback unavailable: ${errorMessage(error)}`);
      }
      return false;
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
