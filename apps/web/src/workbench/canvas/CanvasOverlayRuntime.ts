import type { FloatingBarPlacement } from '../shell/floatingBars';
import type { CanvasRect } from './runtime/canvasGeometry';

export interface CanvasOverlayRuntime {
  bindMinimapViewport(element: SVGRectElement): () => void;
  setMinimapViewport(rect: CanvasRect): void;
  bindFeedbackBar(element: HTMLElement): () => void;
  setFeedbackBarPlacement(rect: FloatingBarPlacement): void;
  suspendFeedbackBarPlacement(): void;
  resumeFeedbackBarPlacement(): void;
  resumeFeedbackBarPlacementAfterNextUpdate(): void;
  clearFeedbackBarPlacement(): void;
  dispose(): void;
}

type FeedbackBarPlacementState = 'active' | 'suspended' | 'resume-after-update';

export function createCanvasOverlayRuntime(): CanvasOverlayRuntime {
  let minimapViewport: SVGRectElement | undefined;
  let feedbackBar: HTMLElement | undefined;
  let currentMinimapRect: CanvasRect | undefined;
  let currentFeedbackRect: FloatingBarPlacement | undefined;
  let feedbackBarPlacementState: FeedbackBarPlacementState = 'active';
  let lastMinimapRect = '';
  let lastFeedbackRect = '';

  return {
    bindMinimapViewport(element) {
      minimapViewport = element;
      lastMinimapRect = '';
      if (currentMinimapRect) {
        writeMinimapViewport(element, currentMinimapRect);
        lastMinimapRect = rectSignature(currentMinimapRect);
      }
      return () => {
        if (minimapViewport === element) {
          minimapViewport = undefined;
        }
      };
    },
    setMinimapViewport(rect) {
      currentMinimapRect = rect;
      if (!minimapViewport) {
        return;
      }
      const signature = rectSignature(rect);
      if (signature === lastMinimapRect) {
        return;
      }
      lastMinimapRect = signature;
      writeMinimapViewport(minimapViewport, rect);
    },
    bindFeedbackBar(element) {
      feedbackBar = element;
      lastFeedbackRect = '';
      if (currentFeedbackRect) {
        writeFeedbackBarPlacement(element, currentFeedbackRect);
        lastFeedbackRect = rectSignature(currentFeedbackRect);
        if (feedbackBarPlacementState !== 'active') {
          suspendFeedbackBar(element);
        } else {
          showFeedbackBar(element);
        }
      } else {
        hideFeedbackBar(element);
      }
      return () => {
        if (feedbackBar === element) {
          feedbackBar = undefined;
        }
      };
    },
    setFeedbackBarPlacement(rect) {
      currentFeedbackRect = rect;
      if (feedbackBarPlacementState === 'suspended') {
        return;
      }
      if (feedbackBarPlacementState === 'resume-after-update') {
        feedbackBarPlacementState = 'active';
      }
      if (!feedbackBar) {
        return;
      }
      const signature = rectSignature(rect);
      if (signature !== lastFeedbackRect) {
        lastFeedbackRect = signature;
        writeFeedbackBarPlacement(feedbackBar, rect);
      }
      showFeedbackBar(feedbackBar);
    },
    suspendFeedbackBarPlacement() {
      if (feedbackBarPlacementState === 'suspended') {
        return;
      }
      feedbackBarPlacementState = 'suspended';
      if (feedbackBar && currentFeedbackRect) {
        suspendFeedbackBar(feedbackBar);
      }
    },
    resumeFeedbackBarPlacement() {
      if (feedbackBarPlacementState === 'active') {
        return;
      }
      feedbackBarPlacementState = 'active';
      if (!feedbackBar || !currentFeedbackRect) {
        return;
      }
      const signature = rectSignature(currentFeedbackRect);
      if (signature !== lastFeedbackRect) {
        lastFeedbackRect = signature;
        writeFeedbackBarPlacement(feedbackBar, currentFeedbackRect);
      }
      showFeedbackBar(feedbackBar);
    },
    resumeFeedbackBarPlacementAfterNextUpdate() {
      if (feedbackBarPlacementState === 'active') {
        return;
      }
      feedbackBarPlacementState = 'resume-after-update';
    },
    clearFeedbackBarPlacement() {
      currentFeedbackRect = undefined;
      feedbackBarPlacementState = 'active';
      if (!feedbackBar) {
        return;
      }
      lastFeedbackRect = '';
      feedbackBar.style.removeProperty('left');
      feedbackBar.style.removeProperty('top');
      feedbackBar.style.removeProperty('width');
      feedbackBar.style.removeProperty('height');
      feedbackBar.style.removeProperty('transform');
      hideFeedbackBar(feedbackBar);
    },
    dispose() {
      minimapViewport = undefined;
      feedbackBar = undefined;
      currentMinimapRect = undefined;
      currentFeedbackRect = undefined;
      feedbackBarPlacementState = 'active';
      lastMinimapRect = '';
      lastFeedbackRect = '';
    }
  };
}

function rectSignature(rect: CanvasRect | FloatingBarPlacement): string {
  return `${rect.x}:${rect.y}:${rect.width}:${rect.height}:${'placement' in rect ? rect.placement : ''}`;
}

function writeMinimapViewport(element: SVGRectElement, rect: CanvasRect): void {
  element.setAttribute('x', String(rect.x));
  element.setAttribute('y', String(rect.y));
  element.setAttribute('width', String(Math.max(2, rect.width)));
  element.setAttribute('height', String(Math.max(2, rect.height)));
}

function writeFeedbackBarPlacement(element: HTMLElement, rect: FloatingBarPlacement): void {
  element.style.left = `${rect.x}px`;
  element.style.width = `${rect.width}px`;
  element.style.removeProperty('height');
  if (rect.placement === 'above') {
    element.style.top = `${rect.y + rect.height}px`;
    element.style.transform = 'translateY(-100%)';
  } else {
    element.style.top = `${rect.y}px`;
    element.style.removeProperty('transform');
  }
}

function showFeedbackBar(element: HTMLElement): void {
  element.inert = false;
  element.style.visibility = 'visible';
  element.style.removeProperty('opacity');
  element.style.removeProperty('pointer-events');
}

function suspendFeedbackBar(element: HTMLElement): void {
  element.inert = true;
  element.style.visibility = 'visible';
  element.style.opacity = '0';
  element.style.pointerEvents = 'none';
}

function hideFeedbackBar(element: HTMLElement): void {
  element.inert = true;
  element.style.visibility = 'hidden';
  element.style.removeProperty('opacity');
  element.style.removeProperty('pointer-events');
}
