import { describe, expect, it } from 'vitest';
import { createCanvasPerfMonitor, type CanvasPerfTraceEvent } from '../CanvasPerfMonitor';
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

  it('restores a culled node display without clearing its layout during a pan back', () => {
    const runtime = createCanvasStageRuntime();
    const element = fakeElement();

    runtime.registerNodeShell('flow/a.png', element as unknown as HTMLElement);
    runtime.setNodeLayout('flow/a.png', { x: 10, y: 20, width: 320, height: 180, z: 7 });
    runtime.setNodeVisible('flow/a.png', true);
    runtime.setNodeVisible('flow/a.png', false);
    runtime.setNodeVisible('flow/a.png', true);

    expect(element.style.transform).toBe('translate(10px, 20px)');
    expect(element.style.properties.get('width')).toBe('320px');
    expect(element.style.properties.get('height')).toBe('180px');
    expect(element.style.properties.get('z-index')).toBe('7');
    expect(element.style.properties.get('display')).toBe('block');
  });

  it('ignores move-node drag previews because move layout comes from render snapshots', () => {
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

    expect(element.style.transform).toBe('translate(10px, 20px)');

    runtime.clearDragPreview();

    expect(element.style.transform).toBe('translate(10px, 20px)');
  });

  it('records camera write and no-op counters', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const sessionId = monitor.startSession({ type: 'camera-pan', timestamp: 0, source: 'CanvasSurface' });
    if (!sessionId) {
      throw new Error('Expected enabled monitor session.');
    }
    const runtime = createCanvasStageRuntime({ perfMonitor: monitor });
    const stage = fakeElement();

    runtime.bindStage(stage as unknown as HTMLElement);
    runtime.setCamera({ x: 12, y: 8, z: 1.5 });
    runtime.setCamera({ x: 12, y: 8, z: 1.5 });

    monitor.endSession({ sessionId, timestamp: 20, source: 'CanvasSurface' });

    expect(counterNames(monitor.getTrace().events)).toEqual([
      'stage-camera-write',
      'stage-camera-noop'
    ]);
    expect(monitor.getLastSession()?.counters).toMatchObject({
      'stage-camera-write': 1,
      'stage-camera-noop': 1
    });
  });

  it('records layout and visibility counters without move preview writes', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const sessionId = monitor.startSession({ type: 'drag-move-node', timestamp: 0, source: 'CanvasSurface' });
    if (!sessionId) {
      throw new Error('Expected enabled monitor session.');
    }
    const runtime = createCanvasStageRuntime({ perfMonitor: monitor });
    const element = fakeElement();

    runtime.registerNodeShell('flow/a.png', element as unknown as HTMLElement);
    runtime.setNodeLayout('flow/a.png', { x: 10, y: 20, width: 320, height: 180, z: 7 });
    runtime.setNodeLayout('flow/a.png', { x: 10, y: 20, width: 320, height: 180, z: 7 });
    runtime.setNodeVisible('flow/a.png', false);
    runtime.setNodeVisible('flow/a.png', false);
    runtime.applyDragPreview({
      kind: 'move-node',
      pointerId: 1,
      start: { x: 0, y: 0 },
      current: { x: 15, y: 25 },
      origins: [{ projectRelativePath: 'flow/a.png', x: 10, y: 20, width: 320, height: 180, locked: false }]
    });

    monitor.endSession({ sessionId, timestamp: 20, source: 'CanvasSurface' });

    expect(monitor.getLastSession()?.counters).toMatchObject({
      'stage-node-layout-write': 1,
      'stage-node-layout-noop': 1,
      'stage-node-visibility-write': 1,
      'stage-node-visibility-noop': 1
    });
    expect(monitor.getLastSession()?.counters).not.toHaveProperty('stage-drag-preview-write');
  });

  it('records resize preview writes for transform and size updates', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const sessionId = monitor.startSession({ type: 'drag-resize-node', timestamp: 0, source: 'CanvasSurface' });
    if (!sessionId) {
      throw new Error('Expected enabled monitor session.');
    }
    const runtime = createCanvasStageRuntime({ perfMonitor: monitor });
    const element = fakeElement();

    runtime.registerNodeShell('flow/a.png', element as unknown as HTMLElement);
    runtime.setNodeLayout('flow/a.png', { x: 10, y: 20, width: 320, height: 180, z: 7 });
    runtime.applyDragPreview({
      kind: 'resize-node',
      pointerId: 1,
      handle: 'se',
      start: { x: 0, y: 0 },
      current: { x: 20, y: 10 },
      node: { projectRelativePath: 'flow/a.png' },
      origin: { x: 10, y: 20, width: 320, height: 180 },
      preserveAspect: false
    });

    monitor.endSession({ sessionId, timestamp: 20, source: 'CanvasSurface' });

    expect(element.style.transform).toBe('translate(10px, 20px)');
    expect(element.style.properties.get('width')).toBe('340px');
    expect(element.style.properties.get('height')).toBe('190px');
    expect(monitor.getLastSession()?.counters).toMatchObject({
      'stage-drag-preview-write': 1
    });
  });
});

function counterNames(events: readonly CanvasPerfTraceEvent[]): string[] {
  return events
    .filter((event) => event.kind === 'counter')
    .map((event) => event.name);
}

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
