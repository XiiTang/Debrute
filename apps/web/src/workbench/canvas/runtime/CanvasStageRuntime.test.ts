import { describe, expect, it } from 'vitest';
import { createCanvasStageRuntime } from './CanvasStageRuntime';

describe('CanvasStageRuntime', () => {
  it('writes camera transform once for repeated camera values', () => {
    const runtime = createCanvasStageRuntime();
    const stage = fakeElement();

    runtime.bindStage(stage as unknown as HTMLElement);
    runtime.setCamera({ x: 12, y: 8, z: 1.5 });
    const transform = stage.style.transform;

    runtime.setCamera({ x: 12, y: 8, z: 1.5 });

    expect(stage.style.transform).toBe(transform);
    expect(stage.style.properties.get('--canvas-zoom')).toBe('1.5');
    expect(stage.style.properties.get('--canvas-chrome-scale')).toBe(String(1 / 1.5));
    expect(stage.style.writeCount).toBe(3);
  });

  it('registers node shells and writes layout, z-index, and display state', () => {
    const runtime = createCanvasStageRuntime();
    const element = fakeElement();

    runtime.registerNodeShell('flow/a.png', element as unknown as HTMLElement);
    runtime.setNodeLayout('flow/a.png', { x: 10, y: 20, width: 320, height: 180, z: 7 });
    runtime.setNodeVisible('flow/a.png', false);

    expect(element.style.transform).toBe('translate(10px, 20px)');
    expect(element.style.properties.get('width')).toBe('320px');
    expect(element.style.properties.get('height')).toBe('180px');
    expect(element.style.properties.get('z-index')).toBe('7');
    expect(element.style.properties.get('display')).toBe('none');
  });

  it('applies drag previews without mutating stored final layout', () => {
    const runtime = createCanvasStageRuntime();
    const element = fakeElement();

    runtime.registerNodeShell('flow/a.png', element as unknown as HTMLElement);
    runtime.setNodeLayout('flow/a.png', { x: 10, y: 20, width: 320, height: 180, z: 7 });
    runtime.applyDragPreview({
      kind: 'move-node',
      pointerId: 1,
      start: { x: 0, y: 0 },
      current: { x: 15, y: 25 },
      origins: [{ projectRelativePath: 'flow/a.png', x: 10, y: 20, width: 320, height: 180, locked: false }]
    });

    expect(element.style.transform).toBe('translate(25px, 45px)');

    runtime.clearDragPreview();

    expect(element.style.transform).toBe('translate(10px, 20px)');
  });
});

function fakeElement(): {
  style: {
    transform: string;
    writeCount: number;
    properties: Map<string, string>;
    setProperty(name: string, value: string): void;
  };
} {
  let transformValue = '';
  return {
    style: {
      get transform() {
        return transformValue;
      },
      set transform(value: string) {
        transformValue = value;
        this.writeCount += 1;
      },
      writeCount: 0,
      properties: new Map(),
      setProperty(name, value) {
        this.properties.set(name, value);
        this.writeCount += 1;
      }
    }
  };
}
