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
    runtime.setFeedbackBarPlacement({ x: 10, y: 20, width: 240, height: 32 });

    expect(element.style.left).toBe('10px');
    expect(element.style.top).toBe('20px');
    expect(element.style.width).toBe('240px');
    expect(element.style.height).toBe('32px');
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
  style: {
    left: string;
    top: string;
    width: string;
    height: string;
    removeProperty(name: string): void;
  };
} {
  return {
    style: {
      left: '',
      top: '',
      width: '',
      height: '',
      removeProperty(name) {
        if (name === 'left' || name === 'top' || name === 'width' || name === 'height') {
          this[name] = '';
        }
      }
    }
  };
}
