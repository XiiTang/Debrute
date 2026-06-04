import { describe, expect, it } from 'vitest';
import { createCanvasLayerRuntime } from './CanvasLayerRuntime';

describe('CanvasLayerRuntime', () => {
  it('writes camera transform and zoom CSS variables to the bound stage', () => {
    const runtime = createCanvasLayerRuntime();
    const stage = fakeElement();

    const unbind = runtime.bindStage(stage as unknown as HTMLElement);
    runtime.setCamera({ x: 12, y: -8, z: 1.5 });
    runtime.setCamera({ x: 12, y: -8, z: 1.5 });

    expect(stage.style.transform).toBe('translate(12px, -8px) scale(1.5)');
    expect(stage.style.properties.get('--canvas-zoom')).toBe('1.5');
    expect(stage.style.properties.get('--canvas-chrome-scale')).toBe(String(1 / 1.5));
    expect(stage.style.writeCount).toBe(3);

    unbind();
    runtime.setCamera({ x: 0, y: 0, z: 1 });
    expect(stage.style.transform).toBe('translate(12px, -8px) scale(1.5)');
  });

  it('writes node shell layout and skips repeated identical writes', () => {
    const runtime = createCanvasLayerRuntime();
    const node = fakeElement();
    runtime.registerNodeShell('flow/cover.png', node as unknown as HTMLElement);

    runtime.setNodeLayout('flow/cover.png', { x: 10, y: 20, width: 300, height: 200, z: 7 });
    runtime.setNodeLayout('flow/cover.png', { x: 10, y: 20, width: 300, height: 200, z: 7 });

    expect(node.style.transform).toBe('translate(10px, 20px)');
    expect(node.style.properties.get('width')).toBe('300px');
    expect(node.style.properties.get('height')).toBe('200px');
    expect(node.style.properties.get('z-index')).toBe('7');
    expect(node.style.writeCount).toBe(4);
  });

  it('toggles registered node shell display without unregistering the node', () => {
    const runtime = createCanvasLayerRuntime();
    const node = fakeElement();
    runtime.registerNodeShell('flow/cover.png', node as unknown as HTMLElement);

    runtime.setNodeVisible('flow/cover.png', false);
    runtime.setNodeVisible('flow/cover.png', false);
    runtime.setNodeVisible('flow/cover.png', true);

    expect(node.style.properties.get('display')).toBe('block');
    expect(node.style.writeCount).toBe(2);
  });

  it('applies node shell visibility that was set before registration', () => {
    const runtime = createCanvasLayerRuntime();
    const node = fakeElement();

    runtime.setNodeVisible('flow/cover.png', false);
    runtime.registerNodeShell('flow/cover.png', node as unknown as HTMLElement);

    expect(node.style.properties.get('display')).toBe('none');
  });

  it('applies and clears move drag previews for active node shells only', () => {
    const runtime = createCanvasLayerRuntime();
    const active = fakeElement();
    const inactive = fakeElement();
    runtime.registerNodeShell('flow/a.png', active as unknown as HTMLElement);
    runtime.registerNodeShell('flow/b.png', inactive as unknown as HTMLElement);
    runtime.setNodeLayout('flow/a.png', { x: 10, y: 20, width: 100, height: 80, z: 1 });
    runtime.setNodeLayout('flow/b.png', { x: 30, y: 40, width: 100, height: 80, z: 2 });

    runtime.applyDragPreview({
      kind: 'move-node',
      pointerId: 1,
      start: { x: 0, y: 0 },
      current: { x: 5, y: 6 },
      origins: [{ projectRelativePath: 'flow/a.png', x: 10, y: 20, width: 100, height: 80, locked: false }]
    });

    expect(active.style.transform).toBe('translate(15px, 26px)');
    expect(inactive.style.transform).toBe('translate(30px, 40px)');

    runtime.clearDragPreview();
    expect(active.style.transform).toBe('translate(10px, 20px)');
  });

  it('uses resize drag state aspect-ratio intent for preview dimensions', () => {
    const runtime = createCanvasLayerRuntime();
    const node = fakeElement();
    runtime.registerNodeShell('flow/cover.png', node as unknown as HTMLElement);
    runtime.setNodeLayout('flow/cover.png', { x: 10, y: 20, width: 100, height: 50, z: 1 });

    runtime.applyDragPreview({
      kind: 'resize-node',
      pointerId: 1,
      handle: 'se',
      start: { x: 0, y: 0 },
      current: { x: 100, y: 50 },
      node: { projectRelativePath: 'flow/cover.png', mediaKind: 'image' },
      origin: { x: 10, y: 20, width: 100, height: 50 },
      preserveAspect: true
    });

    expect(node.style.properties.get('width')).toBe('200px');
    expect(node.style.properties.get('height')).toBe('100px');
  });

  it('keeps repeated move drag previews to active-node no-op writes', () => {
    const runtime = createCanvasLayerRuntime();
    const active = fakeElement();
    const inactive = fakeElement();
    runtime.registerNodeShell('flow/a.png', active as unknown as HTMLElement);
    runtime.registerNodeShell('flow/b.png', inactive as unknown as HTMLElement);
    runtime.setNodeLayout('flow/a.png', { x: 10, y: 20, width: 100, height: 80, z: 1 });
    runtime.setNodeLayout('flow/b.png', { x: 30, y: 40, width: 100, height: 80, z: 2 });

    const preview = {
      kind: 'move-node' as const,
      pointerId: 1,
      start: { x: 0, y: 0 },
      current: { x: 5, y: 6 },
      origins: [{ projectRelativePath: 'flow/a.png', x: 10, y: 20, width: 100, height: 80, locked: false }]
    };
    runtime.applyDragPreview(preview);
    expect(active.style.writeCount).toBe(5);
    expect(inactive.style.writeCount).toBe(4);

    runtime.applyDragPreview(preview);
    expect(active.style.writeCount).toBe(5);
    expect(inactive.style.writeCount).toBe(4);

    runtime.applyDragPreview({ ...preview, current: { x: 7, y: 9 } });
    expect(active.style.transform).toBe('translate(17px, 29px)');
    expect(active.style.writeCount).toBe(6);
    expect(inactive.style.writeCount).toBe(4);
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
