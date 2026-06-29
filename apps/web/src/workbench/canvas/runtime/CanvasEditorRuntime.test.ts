import { describe, expect, it, vi } from 'vitest';
import { createCanvasEditorRuntime } from './CanvasEditorRuntime';

describe('CanvasEditorRuntime', () => {
  it('binds surface size without owning stage transforms', () => {
    const runtime = createCanvasEditorRuntime();

    runtime.bindSurface({
      surface: fakeElement({ left: 20, top: 10, width: 800, height: 600 }) as unknown as HTMLElement
    });
    runtime.camera.setCamera({ x: 12, y: -8, z: 1.5 });

    expect(runtime.getSnapshot().surfaceSize).toEqual({ width: 800, height: 600 });
    expect(runtime.camera.getCamera()).toEqual({ x: 12, y: -8, z: 1.5 });
  });

  it('defers subscriber camera snapshots until camera movement settles', () => {
    vi.useFakeTimers();
    const restoreWindow = installBrowserRuntime();
    try {
      const runtime = createCanvasEditorRuntime();
      runtime.bindSurface({
        surface: fakeElement({ left: 20, top: 10, width: 800, height: 600 }) as unknown as HTMLElement
      });
      const snapshots: unknown[] = [];
      runtime.subscribe((snapshot) => snapshots.push(snapshot.camera));

      runtime.camera.setCamera({ x: 12, y: -8, z: 1.5 });

      expect(snapshots).toEqual([]);

      vi.advanceTimersByTime(64);

      expect(snapshots).toEqual([{ x: 12, y: -8, z: 1.5 }]);
    } finally {
      restoreWindow();
      vi.useRealTimers();
    }
  });

  it('notifies live camera subscribers without publishing React snapshots', () => {
    const restoreWindow = installBrowserRuntime({
      requestAnimationFrame: () => {
        throw new Error('Camera hot-path subscribers must not wait for requestAnimationFrame.');
      }
    });
    try {
      const runtime = createCanvasEditorRuntime();
      runtime.bindSurface({
        surface: fakeElement({ left: 20, top: 10, width: 800, height: 600 }) as unknown as HTMLElement
      });
      const cameras: unknown[] = [];
      const snapshots: unknown[] = [];
      runtime.subscribeCamera((camera) => cameras.push(camera));
      runtime.subscribe((snapshot) => snapshots.push(snapshot.camera));

      runtime.camera.setCamera({ x: 12, y: -8, z: 1.5 });

      expect(cameras).toEqual([{ x: 12, y: -8, z: 1.5 }]);
      expect(snapshots).toEqual([]);
    } finally {
      restoreWindow();
    }
  });

  it('notifies camera-state subscribers when camera movement starts and settles', () => {
    vi.useFakeTimers();
    const restoreWindow = installBrowserRuntime();
    try {
      const runtime = createCanvasEditorRuntime();
      runtime.bindSurface({
        surface: fakeElement({ left: 0, top: 0, width: 800, height: 600 }) as unknown as HTMLElement
      });
      const cameraStates: unknown[] = [];
      runtime.subscribeCameraState((state) => cameraStates.push(state));

      runtime.camera.setCamera({ x: 10, y: 20, z: 1.5 });
      runtime.camera.setCamera({ x: 12, y: 24, z: 1.6 });

      expect(cameraStates).toEqual(['moving']);

      vi.advanceTimersByTime(64);

      expect(cameraStates).toEqual(['moving', 'idle']);
    } finally {
      restoreWindow();
      vi.useRealTimers();
    }
  });

  it('removes camera-state subscribers through the unsubscribe function', () => {
    vi.useFakeTimers();
    const restoreWindow = installBrowserRuntime();
    try {
      const runtime = createCanvasEditorRuntime();
      runtime.bindSurface({
        surface: fakeElement({ left: 0, top: 0, width: 800, height: 600 }) as unknown as HTMLElement
      });
      const cameraStates: unknown[] = [];
      const unsubscribe = runtime.subscribeCameraState((state) => cameraStates.push(state));

      unsubscribe();
      runtime.camera.setCamera({ x: 10, y: 20, z: 1.5 });
      vi.advanceTimersByTime(64);

      expect(cameraStates).toEqual([]);
    } finally {
      restoreWindow();
      vi.useRealTimers();
    }
  });

  it('notifies narrow runtime subscribers only when their field changes', () => {
    const runtime = createCanvasEditorRuntime();
    const selections: unknown[] = [];
    const surfaceSizes: unknown[] = [];

    runtime.subscribeSelection((selection) => selections.push(selection));
    runtime.subscribeSurfaceSize((size) => surfaceSizes.push(size));

    runtime.camera.setCamera({ x: 12, y: 8, z: 1.25 });

    expect(selections).toEqual([]);
    expect(surfaceSizes).toEqual([]);

    runtime.setSelection({ kind: 'node', projectRelativePath: 'flow/a.png' });
    runtime.bindSurface({
      surface: fakeElement({ left: 0, top: 0, width: 640, height: 480 }) as unknown as HTMLElement
    });

    expect(selections).toEqual([{ kind: 'node', projectRelativePath: 'flow/a.png' }]);
    expect(surfaceSizes).toEqual([{ width: 640, height: 480 }]);
  });

  it('exposes current snapshots inside narrow subscriber callbacks', () => {
    vi.useFakeTimers();
    const restoreWindow = installBrowserRuntime();
    try {
      const runtime = createCanvasEditorRuntime();
      runtime.getSnapshot();
      const snapshots: unknown[] = [];

      runtime.subscribeSurfaceSize(() => snapshots.push(['surfaceSize', runtime.getSnapshot().surfaceSize]));
      runtime.subscribeSelection(() => snapshots.push(['selection', runtime.getSnapshot().selection]));
      runtime.subscribeCameraState(() => snapshots.push(['cameraState', runtime.getSnapshot().cameraState]));

      runtime.bindSurface({
        surface: fakeElement({ left: 0, top: 0, width: 640, height: 480 }) as unknown as HTMLElement
      });
      runtime.setSelection({ kind: 'node', projectRelativePath: 'flow/a.png' });
      runtime.camera.setCamera({ x: 10, y: 20, z: 1.5 });
      vi.advanceTimersByTime(64);

      expect(snapshots).toEqual([
        ['surfaceSize', { width: 640, height: 480 }],
        ['selection', { kind: 'node', projectRelativePath: 'flow/a.png' }],
        ['cameraState', 'moving'],
        ['cameraState', 'idle']
      ]);
    } finally {
      restoreWindow();
      vi.useRealTimers();
    }
  });

  it('removes narrow runtime subscribers through their unsubscribe functions', () => {
    const runtime = createCanvasEditorRuntime();
    const selections: unknown[] = [];
    const surfaceSizes: unknown[] = [];

    const unsubscribeSelection = runtime.subscribeSelection((selection) => selections.push(selection));
    const unsubscribeSurfaceSize = runtime.subscribeSurfaceSize((size) => surfaceSizes.push(size));

    unsubscribeSelection();
    unsubscribeSurfaceSize();

    runtime.setSelection({ kind: 'node', projectRelativePath: 'flow/a.png' });
    runtime.bindSurface({
      surface: fakeElement({ left: 0, top: 0, width: 640, height: 480 }) as unknown as HTMLElement
    });

    expect(selections).toEqual([]);
    expect(surfaceSizes).toEqual([]);
  });

  it('updates selection in the local runtime snapshot', () => {
    const runtime = createCanvasEditorRuntime();
    const snapshots: unknown[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot.selection));

    runtime.setSelection({ kind: 'node', projectRelativePath: 'flow/a.png' });

    expect(runtime.getSnapshot().selection).toEqual({ kind: 'node', projectRelativePath: 'flow/a.png' });
    expect(snapshots).toEqual([{ kind: 'node', projectRelativePath: 'flow/a.png' }]);
  });

  it('converts screen points through the bound surface and live camera', () => {
    const runtime = createCanvasEditorRuntime({ camera: { x: 40, y: 20, z: 2 } });
    runtime.bindSurface({
      surface: fakeElement({ left: 100, top: 50, width: 800, height: 600 }) as unknown as HTMLElement
    });

    expect(runtime.coordinates.screenToCanvas({ x: 300, y: 250 })).toEqual({ x: 80, y: 90 });
  });

  it('keeps node drag state in the runtime snapshot', () => {
    const runtime = createCanvasEditorRuntime();
    const snapshots: unknown[] = [];
    const liveDragStates: unknown[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot.dragState));
    runtime.subscribeDragState((state) => liveDragStates.push(state));

    runtime.input.beginNodeMove({
      pointerId: 7,
      node: moveNode('flow/a.png', 10, 20),
      start: { x: 0, y: 0 },
      selection: { kind: 'node', projectRelativePath: 'flow/a.png' },
      nodes: [
        moveNode('flow/a.png', 10, 20),
        moveNode('flow/b.png', 30, 40)
      ]
    });
    runtime.input.updatePointer({ pointerId: 7, point: { x: 5, y: 6 } });
    const finished = runtime.input.finishPointer({ pointerId: 7 });

    expect(finished).toMatchObject({
      kind: 'move-node',
      pointerId: 7,
      current: { x: 5, y: 6 },
      origins: [{ projectRelativePath: 'flow/a.png', x: 10, y: 20 }]
    });
    expect(liveDragStates).toHaveLength(3);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)).toBeUndefined();
  });

  it('does not notify broad snapshot subscribers for pointer move drag previews', () => {
    const runtime = createCanvasEditorRuntime();
    const snapshots: unknown[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot));
    runtime.input.beginNodeMove({
      pointerId: 7,
      start: { x: 0, y: 0 },
      node: moveNode('flow/a.png', 0, 0),
      selection: { kind: 'node', projectRelativePath: 'flow/a.png' },
      nodes: [moveNode('flow/a.png', 0, 0)]
    });
    snapshots.length = 0;

    const updated = runtime.input.updatePointer({
      pointerId: 7,
      point: { x: 20, y: 30 }
    });

    expect(updated).toBe(true);
    expect(snapshots).toEqual([]);
  });
});

function fakeElement(rect = { left: 0, top: 0, width: 1, height: 1 }): {
  style: {
    properties: Map<string, string>;
    transform: string;
    setProperty(name: string, value: string): void;
  };
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
} {
  return {
    style: {
      properties: new Map<string, string>(),
      transform: '',
      setProperty(name, value) {
        this.properties.set(name, value);
      }
    },
    getBoundingClientRect: () => rect
  };
}

function moveNode(projectRelativePath: string, x: number, y: number) {
  return {
    projectRelativePath,
    x,
    y,
    width: 100,
    height: 80
  };
}

function installBrowserRuntime(input: {
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
} = {}): () => void {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: input.requestAnimationFrame ?? ((callback: FrameRequestCallback) => (
        Number(globalThis.setTimeout(() => callback(0), 0))
      )),
      cancelAnimationFrame: (id: number) => {
        globalThis.clearTimeout(id);
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
  });
  return () => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
      return;
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: originalWindow
    });
  };
}
