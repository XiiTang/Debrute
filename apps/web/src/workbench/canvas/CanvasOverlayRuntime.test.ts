import { describe, expect, it } from 'vitest';
import { createCanvasOverlayRuntime } from './CanvasOverlayRuntime';

describe('CanvasOverlayRuntime', () => {
  it('updates minimap viewport rect without rebuilding minimap nodes', () => {
    const runtime = createCanvasOverlayRuntime();
    const viewport = fakeSvgRectElement();

    runtime.bindMinimapViewport(viewport as unknown as SVGRectElement);
    runtime.setMinimapViewport({ x: 4, y: 6, width: 20, height: 30 });
    runtime.setMinimapViewport({ x: 4, y: 6, width: 20, height: 30 });

    expect(viewport.attributes.get('x')).toBe('4');
    expect(viewport.attributes.get('y')).toBe('6');
    expect(viewport.attributes.get('width')).toBe('20');
    expect(viewport.attributes.get('height')).toBe('30');
    expect(viewport.writeCount).toBe(4);
  });

  it('writes feedback bar placement directly to the bound element', () => {
    const runtime = createCanvasOverlayRuntime();
    const element = fakeElement();

    runtime.bindFeedbackBar(element as unknown as HTMLElement);
    runtime.setFeedbackBarPlacement({ x: 10, y: 20, width: 240, height: 124, placement: 'below' });

    expect(element.style.left).toBe('10px');
    expect(element.style.top).toBe('20px');
    expect(element.style.width).toBe('240px');
    expect(element.style.height).toBe('');
    expect(element.style.transform).toBe('');
    expect(element.style.visibility).toBe('visible');
  });

  it('anchors an auto-height feedback bar above the node by its bottom edge', () => {
    const runtime = createCanvasOverlayRuntime();
    const element = fakeElement();

    runtime.bindFeedbackBar(element as unknown as HTMLElement);
    runtime.setFeedbackBarPlacement({ x: 10, y: 20, width: 240, height: 124, placement: 'above' });

    expect(element.style.top).toBe('144px');
    expect(element.style.height).toBe('');
    expect(element.style.transform).toBe('translateY(-100%)');
  });

  it('applies an existing feedback bar placement when the element binds', () => {
    const runtime = createCanvasOverlayRuntime();
    const element = fakeElement();

    runtime.setFeedbackBarPlacement({ x: 10, y: 20, width: 240, height: 124, placement: 'below' });
    runtime.bindFeedbackBar(element as unknown as HTMLElement);

    expect(element.style.left).toBe('10px');
    expect(element.style.top).toBe('20px');
    expect(element.style.width).toBe('240px');
    expect(element.style.height).toBe('');
    expect(element.style.visibility).toBe('visible');
  });

  it('keeps the feedback bar hidden while no placement is available', () => {
    const runtime = createCanvasOverlayRuntime();
    const element = fakeElement();

    runtime.clearFeedbackBarPlacement();
    runtime.bindFeedbackBar(element as unknown as HTMLElement);

    expect(element.inert).toBe(true);
    expect(element.style.visibility).toBe('hidden');

    runtime.setFeedbackBarPlacement({ x: 10, y: 20, width: 240, height: 124, placement: 'below' });
    expect(element.style.visibility).toBe('visible');

    runtime.clearFeedbackBarPlacement();
    expect(element.style.left).toBe('');
    expect(element.style.top).toBe('');
    expect(element.style.width).toBe('');
    expect(element.style.height).toBe('');
    expect(element.style.transform).toBe('');
    expect(element.style.visibility).toBe('hidden');
  });

  it('keeps the latest feedback placement hidden while transient feedback is suspended', () => {
    const runtime = createCanvasOverlayRuntime();
    const element = fakeElement();

    runtime.bindFeedbackBar(element as unknown as HTMLElement);
    runtime.setFeedbackBarPlacement({ x: 10, y: 20, width: 240, height: 124, placement: 'below' });

    runtime.suspendFeedbackBarPlacement();
    expect(element.inert).toBe(true);
    expect(element.style.visibility).toBe('visible');
    expect(element.style.opacity).toBe('0');
    expect(element.style.pointerEvents).toBe('none');

    runtime.setFeedbackBarPlacement({ x: 30, y: 40, width: 260, height: 144, placement: 'above' });
    expect(element.style.visibility).toBe('visible');
    expect(element.style.opacity).toBe('0');
    expect(element.style.pointerEvents).toBe('none');

    runtime.resumeFeedbackBarPlacement();
    expect(element.style.left).toBe('30px');
    expect(element.style.top).toBe('184px');
    expect(element.style.width).toBe('260px');
    expect(element.style.transform).toBe('translateY(-100%)');
    expect(element.inert).toBe(false);
    expect(element.style.visibility).toBe('visible');
    expect(element.style.opacity).toBe('');
    expect(element.style.pointerEvents).toBe('');
  });

  it('does not restore a suspended feedback placement after it is cleared', () => {
    const runtime = createCanvasOverlayRuntime();
    const element = fakeElement();

    runtime.bindFeedbackBar(element as unknown as HTMLElement);
    runtime.setFeedbackBarPlacement({ x: 10, y: 20, width: 240, height: 124, placement: 'below' });
    runtime.suspendFeedbackBarPlacement();
    runtime.clearFeedbackBarPlacement();
    runtime.resumeFeedbackBarPlacement();

    expect(element.style.left).toBe('');
    expect(element.style.top).toBe('');
    expect(element.style.width).toBe('');
    expect(element.style.visibility).toBe('hidden');
  });

  it('waits for the reconciled feedback placement before restoring a suspended Bar', () => {
    const runtime = createCanvasOverlayRuntime();
    const element = fakeElement();

    runtime.bindFeedbackBar(element as unknown as HTMLElement);
    runtime.setFeedbackBarPlacement({ x: 10, y: 20, width: 240, height: 124, placement: 'below' });
    runtime.suspendFeedbackBarPlacement();
    runtime.resumeFeedbackBarPlacementAfterNextUpdate();

    expect(element.style.visibility).toBe('visible');
    expect(element.style.opacity).toBe('0');
    expect(element.style.pointerEvents).toBe('none');

    runtime.setFeedbackBarPlacement({ x: 400, y: 500, width: 280, height: 160, placement: 'above' });

    expect(element.style.left).toBe('400px');
    expect(element.style.top).toBe('660px');
    expect(element.style.width).toBe('280px');
    expect(element.style.transform).toBe('translateY(-100%)');
    expect(element.style.visibility).toBe('visible');
    expect(element.style.opacity).toBe('');
    expect(element.style.pointerEvents).toBe('');
  });

  it('keeps a second Camera movement suspended while a reconciled placement is pending', () => {
    const runtime = createCanvasOverlayRuntime();
    const element = fakeElement();

    runtime.bindFeedbackBar(element as unknown as HTMLElement);
    runtime.setFeedbackBarPlacement({ x: 10, y: 20, width: 240, height: 124, placement: 'below' });
    runtime.suspendFeedbackBarPlacement();
    runtime.resumeFeedbackBarPlacementAfterNextUpdate();

    runtime.suspendFeedbackBarPlacement();
    runtime.setFeedbackBarPlacement({ x: 400, y: 500, width: 280, height: 160, placement: 'above' });

    expect(element.inert).toBe(true);
    expect(element.style.opacity).toBe('0');
    expect(element.style.pointerEvents).toBe('none');

    runtime.resumeFeedbackBarPlacement();

    expect(element.style.left).toBe('400px');
    expect(element.style.top).toBe('660px');
    expect(element.inert).toBe(false);
    expect(element.style.opacity).toBe('');
    expect(element.style.pointerEvents).toBe('');
  });
});

function fakeSvgRectElement(): {
  attributes: Map<string, string>;
  writeCount: number;
  setAttribute(name: string, value: string): void;
} {
  return {
    attributes: new Map(),
    writeCount: 0,
    setAttribute(name, value) {
      this.attributes.set(name, value);
      this.writeCount += 1;
    }
  };
}

function fakeElement(): {
  inert: boolean;
  style: {
    left: string;
    top: string;
    width: string;
    height: string;
    transform: string;
    visibility: string;
    opacity: string;
    pointerEvents: string;
    removeProperty(name: string): void;
  };
} {
  return {
    inert: false,
    style: {
      left: '',
      top: '',
      width: '',
      height: '',
      transform: '',
      visibility: '',
      opacity: '',
      pointerEvents: '',
      removeProperty(name) {
        if (
          name === 'left'
          || name === 'top'
          || name === 'width'
          || name === 'height'
          || name === 'transform'
          || name === 'visibility'
          || name === 'opacity'
          || name === 'pointer-events'
        ) {
          if (name === 'pointer-events') {
            this.pointerEvents = '';
            return;
          }
          this[name] = '';
        }
      }
    }
  };
}
