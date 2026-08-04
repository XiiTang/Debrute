import { describe, expect, it, vi } from 'vitest';
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

  it('resizes node shells through ordinary layout writes', () => {
    const runtime = createCanvasStageRuntime();
    const element = fakeElement();

    runtime.registerNodeShell('flow/a.png', element as unknown as HTMLElement);
    runtime.setNodeLayout('flow/a.png', { x: 10, y: 20, width: 320, height: 180, z: 7 });
    runtime.setNodeLayout('flow/a.png', { x: 10, y: 20, width: 340, height: 190, z: 7 });

    expect(element.style.transform).toBe('translate(10px, 20px)');
    expect(element.style.properties.get('width')).toBe('340px');
    expect(element.style.properties.get('height')).toBe('190px');
    expect(element.style.properties.get('z-index')).toBe('7');
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

  it('moves controlled hover presentation directly between registered node shells', () => {
    const runtime = createCanvasStageRuntime();
    const first = fakeElement();
    const second = fakeElement();

    runtime.registerNodeShell('flow/a.png', first as unknown as HTMLElement);
    runtime.registerNodeShell('flow/b.png', second as unknown as HTMLElement);

    runtime.setHoveredNode('flow/a.png');
    expect(first.attributes.get('data-canvas-hovered')).toBe('true');
    expect(second.attributes.has('data-canvas-hovered')).toBe(false);

    runtime.setHoveredNode('flow/b.png');
    expect(first.attributes.has('data-canvas-hovered')).toBe(false);
    expect(second.attributes.get('data-canvas-hovered')).toBe('true');

    runtime.setHoveredNode(undefined);
    expect(second.attributes.has('data-canvas-hovered')).toBe(false);
  });

  it('writes routed edge group geometry and display without changing React membership', () => {
    const runtime = createCanvasStageRuntime();
    const element = fakeElement();

    runtime.registerEdgeGroup('source', element as unknown as SVGPathElement);
    runtime.setEdgeGroupGeometry('source', 'M 0 0 L 100 100');
    runtime.setEdgeGroupVisible('source', false);
    runtime.setEdgeGroupVisible('source', true);

    expect(element.attributes.get('d')).toBe('M 0 0 L 100 100');
    expect(element.style.properties.get('display')).toBe('block');
  });

  it('applies selected attributes by set difference and notifies only old and new single selections', () => {
    const runtime = createCanvasStageRuntime();
    const first = fakeElement();
    const second = fakeElement();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    runtime.registerNodeShell('first', first as unknown as HTMLElement);
    runtime.registerNodeShell('second', second as unknown as HTMLElement);
    runtime.subscribeSingleSelectedNode('first', firstListener);
    runtime.subscribeSingleSelectedNode('second', secondListener);

    runtime.setSelectedNodePaths(new Set(['first']));
    runtime.setSelectedNodePaths(new Set(['second']));

    expect(first.attributes.has('data-canvas-selected')).toBe(false);
    expect(second.attributes.get('data-canvas-selected')).toBe('true');
    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(secondListener).toHaveBeenCalledTimes(1);
    expect(runtime.isSingleSelectedNode('first')).toBe(false);
    expect(runtime.isSingleSelectedNode('second')).toBe(true);
  });

  it('records camera write and no-op counters', () => {
    const monitor = createCanvasPerfMonitor();
    const sessionId = monitor.startSession({ type: 'camera-pan', timestamp: 0, source: 'CanvasSurface' });
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

  it('records layout and visibility counters', () => {
    const monitor = createCanvasPerfMonitor();
    const sessionId = monitor.startSession({ type: 'pointer-move-node', timestamp: 0, source: 'CanvasSurface' });
    const runtime = createCanvasStageRuntime({ perfMonitor: monitor });
    const element = fakeElement();

    runtime.registerNodeShell('flow/a.png', element as unknown as HTMLElement);
    runtime.setNodeLayout('flow/a.png', { x: 10, y: 20, width: 320, height: 180, z: 7 });
    runtime.setNodeLayout('flow/a.png', { x: 10, y: 20, width: 320, height: 180, z: 7 });
    runtime.setNodeVisible('flow/a.png', false);
    runtime.setNodeVisible('flow/a.png', false);
    const edge = fakeElement();
    runtime.registerEdgeGroup('edge-a-b', edge as unknown as SVGPathElement);
    runtime.setEdgeGroupGeometry('edge-a-b', 'M 0 0 L 10 10');
    runtime.setEdgeGroupGeometry('edge-a-b', 'M 0 0 L 10 10');
    runtime.setEdgeGroupVisible('edge-a-b', false);
    runtime.setEdgeGroupVisible('edge-a-b', false);
    monitor.endSession({ sessionId, timestamp: 20, source: 'CanvasSurface' });

    expect(monitor.getLastSession()?.counters).toMatchObject({
      'stage-node-layout-write': 1,
      'stage-node-layout-noop': 1,
      'stage-node-visibility-write': 1,
      'stage-node-visibility-noop': 1,
      'stage-edge-visibility-write': 1,
      'stage-edge-visibility-noop': 1,
      'stage-edge-geometry-write': 1,
      'stage-edge-geometry-noop': 1
    });
  });
});

function counterNames(events: readonly CanvasPerfTraceEvent[]): string[] {
  return events
    .filter((event) => event.kind === 'counter')
    .map((event) => event.name);
}

function fakeElement(): {
  classes: Set<string>;
  attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    toggle(name: string, force?: boolean): boolean;
  };
  style: {
    transform: string;
    writeCount: number;
    properties: Map<string, string>;
    setProperty(name: string, value: string): void;
  };
} {
  let transformValue = '';
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  return {
    classes,
    attributes,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      toggle(name, force) {
        const next = force ?? !classes.has(name);
        if (next) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return next;
      }
    },
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
