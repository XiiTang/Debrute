import type { FloatingBarRect } from '../shell/floatingBars';
import type { CanvasRect } from './runtime/canvasGeometry';

export interface CanvasOverlayRuntime {
  bindMinimapViewport(element: SVGRectElement): () => void;
  setMinimapViewport(rect: CanvasRect): void;
  bindFeedbackBar(element: HTMLElement): () => void;
  setFeedbackBarPlacement(rect: FloatingBarRect): void;
  clearFeedbackBarPlacement(): void;
  dispose(): void;
}

export function createCanvasOverlayRuntime(): CanvasOverlayRuntime {
  let minimapViewport: SVGRectElement | undefined;
  let feedbackBar: HTMLElement | undefined;
  let currentMinimapRect: CanvasRect | undefined;
  let currentFeedbackRect: FloatingBarRect | undefined;
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
        showFeedbackBar(element);
        writeFeedbackBarPlacement(element, currentFeedbackRect);
        lastFeedbackRect = rectSignature(currentFeedbackRect);
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
      if (!feedbackBar) {
        return;
      }
      const signature = rectSignature(rect);
      if (signature === lastFeedbackRect) {
        return;
      }
      lastFeedbackRect = signature;
      showFeedbackBar(feedbackBar);
      writeFeedbackBarPlacement(feedbackBar, rect);
    },
    clearFeedbackBarPlacement() {
      currentFeedbackRect = undefined;
      if (!feedbackBar) {
        return;
      }
      lastFeedbackRect = '';
      feedbackBar.style.removeProperty('left');
      feedbackBar.style.removeProperty('top');
      feedbackBar.style.removeProperty('width');
      feedbackBar.style.removeProperty('height');
      hideFeedbackBar(feedbackBar);
    },
    dispose() {
      minimapViewport = undefined;
      feedbackBar = undefined;
      currentMinimapRect = undefined;
      currentFeedbackRect = undefined;
      lastMinimapRect = '';
      lastFeedbackRect = '';
    }
  };
}

function rectSignature(rect: CanvasRect | FloatingBarRect): string {
  return `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
}

function writeMinimapViewport(element: SVGRectElement, rect: CanvasRect): void {
  element.setAttribute('x', String(rect.x));
  element.setAttribute('y', String(rect.y));
  element.setAttribute('width', String(Math.max(2, rect.width)));
  element.setAttribute('height', String(Math.max(2, rect.height)));
}

function writeFeedbackBarPlacement(element: HTMLElement, rect: FloatingBarRect): void {
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

function showFeedbackBar(element: HTMLElement): void {
  element.style.visibility = 'visible';
}

function hideFeedbackBar(element: HTMLElement): void {
  element.style.visibility = 'hidden';
}
