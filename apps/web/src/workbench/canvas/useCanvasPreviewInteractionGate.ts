import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  canvasPreviewResourceInteractionActive,
  type CanvasPreviewResourceScheduler
} from './CanvasPreviewResourceScheduler.js';

interface CanvasPreviewInteractionGate {
  readonly interactionActiveRef: RefObject<boolean>;
  readonly resumeVersion: number;
}

export function useCanvasPreviewInteractionGate(input: {
  scheduler: Pick<CanvasPreviewResourceScheduler, 'getInteractionState' | 'subscribeInteraction'>;
  hasPendingWork: () => boolean;
}): CanvasPreviewInteractionGate {
  const interactionActiveRef = useRef(
    canvasPreviewResourceInteractionActive(input.scheduler.getInteractionState())
  );
  const hasPendingWorkRef = useRef(input.hasPendingWork);
  const [resumeVersion, setResumeVersion] = useState(0);
  hasPendingWorkRef.current = input.hasPendingWork;

  useLayoutEffect(() => {
    const syncInteraction = (interaction: ReturnType<typeof input.scheduler.getInteractionState>): void => {
      const previousActive = interactionActiveRef.current;
      const nextActive = canvasPreviewResourceInteractionActive(interaction);
      interactionActiveRef.current = nextActive;
      if (previousActive && !nextActive && hasPendingWorkRef.current()) {
        setResumeVersion((current) => current + 1);
      }
    };
    syncInteraction(input.scheduler.getInteractionState());
    return input.scheduler.subscribeInteraction(syncInteraction);
  }, [input.scheduler]);

  return { interactionActiveRef, resumeVersion };
}
