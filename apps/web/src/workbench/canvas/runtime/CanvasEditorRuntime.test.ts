import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasEditorRuntime } from './CanvasEditorRuntime.js';

describe('CanvasEditorRuntime', () => {
  let restoreBrowserRuntime: () => void;

  beforeEach(() => {
    restoreBrowserRuntime = installBrowserRuntime();
  });

  afterEach(() => {
    restoreBrowserRuntime();
  });

  it('binds surface size without owning stage transforms', () => {
    const runtime = createRuntime();

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
      const runtime = createRuntime();
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
      const runtime = createRuntime();
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
      const runtime = createRuntime();
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
      const runtime = createRuntime();
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
    const runtime = createRuntime();
    const selections: unknown[] = [];
    const surfaceSizes: unknown[] = [];

    runtime.subscribeSelection((selection) => selections.push(selection));
    runtime.subscribeSurfaceSize((size) => surfaceSizes.push(size));

    runtime.camera.setCamera({ x: 12, y: 8, z: 1.25 });

    expect(selections).toEqual([]);
    expect(surfaceSizes).toEqual([]);

    runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['flow/a.png'] });
    runtime.bindSurface({
      surface: fakeElement({ left: 0, top: 0, width: 640, height: 480 }) as unknown as HTMLElement
    });

    expect(selections).toEqual([{ kind: 'nodes', projectRelativePaths: ['flow/a.png'] }]);
    expect(surfaceSizes).toEqual([{ width: 640, height: 480 }]);
  });

  it('exposes current snapshots inside narrow subscriber callbacks', () => {
    vi.useFakeTimers();
    const restoreWindow = installBrowserRuntime();
    try {
      const runtime = createRuntime();
      runtime.getSnapshot();
      const snapshots: unknown[] = [];

      runtime.subscribeSurfaceSize(() => snapshots.push(['surfaceSize', runtime.getSnapshot().surfaceSize]));
      runtime.subscribeSelection(() => snapshots.push(['selection', runtime.getSnapshot().selection]));
      runtime.subscribeCameraState(() => snapshots.push(['cameraState', runtime.getSnapshot().cameraState]));

      runtime.bindSurface({
        surface: fakeElement({ left: 0, top: 0, width: 640, height: 480 }) as unknown as HTMLElement
      });
      runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['flow/a.png'] });
      runtime.camera.setCamera({ x: 10, y: 20, z: 1.5 });
      vi.advanceTimersByTime(64);

      expect(snapshots).toEqual([
        ['surfaceSize', { width: 640, height: 480 }],
        ['selection', { kind: 'nodes', projectRelativePaths: ['flow/a.png'] }],
        ['cameraState', 'moving'],
        ['cameraState', 'idle']
      ]);
    } finally {
      restoreWindow();
      vi.useRealTimers();
    }
  });

  it('removes narrow runtime subscribers through their unsubscribe functions', () => {
    const runtime = createRuntime();
    const selections: unknown[] = [];
    const surfaceSizes: unknown[] = [];

    const unsubscribeSelection = runtime.subscribeSelection((selection) => selections.push(selection));
    const unsubscribeSurfaceSize = runtime.subscribeSurfaceSize((size) => surfaceSizes.push(size));

    unsubscribeSelection();
    unsubscribeSurfaceSize();

    runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['flow/a.png'] });
    runtime.bindSurface({
      surface: fakeElement({ left: 0, top: 0, width: 640, height: 480 }) as unknown as HTMLElement
    });

    expect(selections).toEqual([]);
    expect(surfaceSizes).toEqual([]);
  });

  it('updates selection in the local runtime snapshot', () => {
    const runtime = createRuntime();
    const snapshots: unknown[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot.selection));

    runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['flow/a.png'] });

    expect(runtime.getSnapshot().selection).toEqual({ kind: 'nodes', projectRelativePaths: ['flow/a.png'] });
    expect(snapshots).toEqual([{ kind: 'nodes', projectRelativePaths: ['flow/a.png'] }]);
  });

  it('converts screen points through the bound surface and live camera', () => {
    const runtime = createRuntime({ camera: { x: 40, y: 20, z: 2 } });
    runtime.bindSurface({
      surface: fakeElement({ left: 100, top: 50, width: 800, height: 600 }) as unknown as HTMLElement
    });

    expect(runtime.coordinates.screenToCanvas({ x: 300, y: 250 })).toEqual({ x: 80, y: 90 });
  });

  it('activates a Selection Marquee after four CSS pixels and recomputes intersecting nodes', async () => {
    const runtime = createMarqueeRuntime();
    runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['flow/b.png'] });

    runtime.input.beginSelectionMarquee({
      pointerId: 4,
      screenPoint: { x: 0, y: 0 },
      modifiers: noModifiers()
    });
    runtime.input.updatePointer({
      pointerId: 4,
      screenPoint: { x: 4, y: 0 },
      modifiers: noModifiers()
    });

    expect(runtime.getSnapshot().pointerInteraction).toMatchObject({
      kind: 'selection-marquee',
      phase: 'pending'
    });
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/b.png']
    });

    runtime.input.updatePointer({
      pointerId: 4,
      screenPoint: { x: 80, y: 80 },
      modifiers: noModifiers()
    });
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png']
    });

    runtime.input.updatePointer({
      pointerId: 4,
      screenPoint: { x: 220, y: 220 },
      modifiers: noModifiers()
    });
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png', 'flow/b.png']
    });

    await runtime.input.finishPointer({ pointerId: 4 });
    expect(runtime.getSnapshot().pointerInteraction).toBeUndefined();
  });

  it('unions marquee hits with pointer-down selection and restores it on cancellation', () => {
    const runtime = createMarqueeRuntime();
    runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['flow/b.png'] });

    runtime.input.beginSelectionMarquee({
      pointerId: 5,
      screenPoint: { x: 0, y: 0 },
      modifiers: { ...noModifiers(), shiftKey: true }
    });
    runtime.input.updatePointer({
      pointerId: 5,
      screenPoint: { x: 80, y: 80 },
      modifiers: { ...noModifiers(), shiftKey: true }
    });
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png', 'flow/b.png']
    });

    runtime.input.cancelPointer(5);
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/b.png']
    });
  });

  it('keeps the marquee anchor in Canvas space when the camera changes', () => {
    const runtime = createMarqueeRuntime();
    runtime.bindSurface({
      surface: fakeElement({ left: 0, top: 0, width: 400, height: 300 }) as unknown as HTMLElement
    });
    runtime.input.beginSelectionMarquee({
      pointerId: 6,
      screenPoint: { x: 10, y: 10 },
      modifiers: noModifiers()
    });

    runtime.camera.setCamera({ x: 100, y: 0, z: 1 });
    runtime.input.updatePointer({
      pointerId: 6,
      screenPoint: { x: 80, y: 80 },
      modifiers: noModifiers()
    });

    expect(runtime.getSnapshot().pointerInteraction).toMatchObject({
      kind: 'selection-marquee',
      start: { x: 10, y: 10 },
      current: { x: -20, y: 80 },
      rect: { x: -20, y: 10, width: 30, height: 70 }
    });
  });

  it('edge-scrolls an active marquee after the delay and stops on release, cancellation, and disposal', async () => {
    const frames = controllableAnimationFrames();
    const restoreWindow = installBrowserRuntime({
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel
    });
    try {
      const runtime = createMarqueeRuntime();
      runtime.bindSurface({
        surface: fakeElement({ left: 0, top: 0, width: 400, height: 300 }) as unknown as HTMLElement
      });
      runtime.input.beginSelectionMarquee({
        pointerId: 9,
        screenPoint: { x: 100, y: 100 },
        modifiers: noModifiers()
      });
      runtime.input.updatePointer({
        pointerId: 9,
        screenPoint: { x: 399, y: 100 },
        modifiers: noModifiers()
      });

      frames.step(0);
      frames.step(199);
      expect(runtime.camera.getCamera()).toEqual({ x: 0, y: 0, z: 1 });

      frames.step(300);
      expect(runtime.camera.getCamera().x).toBeLessThan(0);
      const cameraAfterScroll = runtime.camera.getCamera();

      runtime.input.cancelPointer(9);
      frames.step(500);
      expect(runtime.camera.getCamera()).toEqual(cameraAfterScroll);

      runtime.input.beginSelectionMarquee({
        pointerId: 10,
        screenPoint: { x: 100, y: 100 },
        modifiers: noModifiers(),
        topEdgeInset: 40
      });
      runtime.input.updatePointer({
        pointerId: 10,
        screenPoint: { x: 100, y: 41 },
        modifiers: noModifiers()
      });
      frames.step(600);
      frames.step(799);
      expect(runtime.camera.getCamera().y).toBe(0);
      frames.step(900);
      expect(runtime.camera.getCamera().y).toBeGreaterThan(0);
      runtime.input.cancelPointer(10);

      runtime.input.beginSelectionMarquee({
        pointerId: 11,
        screenPoint: { x: 100, y: 100 },
        modifiers: noModifiers()
      });
      runtime.input.updatePointer({
        pointerId: 11,
        screenPoint: { x: 399, y: 100 },
        modifiers: noModifiers()
      });
      frames.step(1000);
      frames.step(1199);
      frames.step(1300);
      await runtime.input.finishPointer({ pointerId: 11 });
      const cameraAfterRelease = runtime.camera.getCamera();
      frames.step(1500);
      expect(runtime.camera.getCamera()).toEqual(cameraAfterRelease);

      runtime.input.beginSelectionMarquee({
        pointerId: 12,
        screenPoint: { x: 100, y: 100 },
        modifiers: noModifiers()
      });
      runtime.input.updatePointer({
        pointerId: 12,
        screenPoint: { x: 399, y: 100 },
        modifiers: noModifiers()
      });
      frames.step(1600);
      frames.step(1799);
      runtime.dispose();
      const cameraAfterDispose = runtime.camera.getCamera();
      frames.step(1900);
      expect(runtime.camera.getCamera()).toEqual(cameraAfterDispose);
    } finally {
      restoreWindow();
    }
  });

  it('clears a plain below-threshold blank click and preserves an additive one', async () => {
    const runtime = createMarqueeRuntime();
    runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['flow/a.png'] });
    runtime.input.beginSelectionMarquee({
      pointerId: 7,
      screenPoint: { x: 0, y: 0 },
      modifiers: noModifiers()
    });
    await runtime.input.finishPointer({
      pointerId: 7,
      screenPoint: { x: 3, y: 0 },
      modifiers: noModifiers()
    });
    expect(runtime.getSnapshot().selection).toBeUndefined();

    runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['flow/a.png'] });
    runtime.input.beginSelectionMarquee({
      pointerId: 8,
      screenPoint: { x: 0, y: 0 },
      modifiers: { ...noModifiers(), metaKey: true }
    });
    await runtime.input.finishPointer({
      pointerId: 8,
      screenPoint: { x: 3, y: 0 },
      modifiers: { ...noModifiers(), metaKey: true }
    });
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png']
    });
  });

  it('recomputes a marquee from live modifiers and every drag direction', () => {
    const runtime = createCanvasEditorRuntime({
      canvasId: 'canvas-1',
      initialProjection: {
        canvasId: 'canvas-1',
        nodes: [
          marqueeNode('nw.png', 50, 50),
          marqueeNode('ne.png', 110, 50),
          marqueeNode('sw.png', 50, 110),
          marqueeNode('se.png', 110, 110)
        ],
        edges: [],
        diagnostics: []
      },
      submitManualLayout: async () => undefined
    });
    runtime.bindSurface({
      surface: fakeElement({ left: 0, top: 0, width: 400, height: 400 }) as unknown as HTMLElement
    });
    const directions = [
      [{ x: 40, y: 40 }, 'nw.png'],
      [{ x: 130, y: 40 }, 'ne.png'],
      [{ x: 40, y: 130 }, 'sw.png'],
      [{ x: 130, y: 130 }, 'se.png']
    ] as const;
    directions.forEach(([screenPoint, expectedPath], index) => {
      const pointerId = 20 + index;
      runtime.input.beginSelectionMarquee({
        pointerId,
        screenPoint: { x: 100, y: 100 },
        modifiers: noModifiers()
      });
      runtime.input.updatePointer({ pointerId, screenPoint, modifiers: noModifiers() });
      expect(runtime.getSnapshot().selection).toEqual({
        kind: 'nodes',
        projectRelativePaths: [expectedPath]
      });
      runtime.input.cancelPointer(pointerId);
    });

    runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['nw.png'] });
    runtime.input.beginSelectionMarquee({
      pointerId: 30,
      screenPoint: { x: 100, y: 100 },
      modifiers: noModifiers()
    });
    runtime.input.updatePointer({
      pointerId: 30,
      screenPoint: { x: 130, y: 40 },
      modifiers: noModifiers()
    });
    expect(runtime.getSnapshot().selection).toEqual({ kind: 'nodes', projectRelativePaths: ['ne.png'] });
    runtime.input.updatePointer({
      pointerId: 30,
      screenPoint: { x: 130, y: 40 },
      modifiers: { ...noModifiers(), shiftKey: true }
    });
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['ne.png', 'nw.png']
    });
    runtime.input.updatePointer({
      pointerId: 30,
      screenPoint: { x: 130, y: 40 },
      modifiers: noModifiers()
    });
    expect(runtime.getSnapshot().selection).toEqual({ kind: 'nodes', projectRelativePaths: ['ne.png'] });
    runtime.input.cancelPointer(30);
  });

  it('includes edge-touching, overlapping, and offscreen Projection nodes without consulting DOM order', () => {
    const runtime = createCanvasEditorRuntime({
      canvasId: 'canvas-1',
      initialProjection: {
        canvasId: 'canvas-1',
        nodes: [
          { ...marqueeNode('touch.png', 20, 0), z: 1 },
          { ...marqueeNode('overlap-front.png', -40, -40), z: 20 },
          { ...marqueeNode('overlap-back.png', -40, -40), z: -5 },
          marqueeNode('outside.png', 21, 50)
        ],
        edges: [],
        diagnostics: []
      },
      submitManualLayout: async () => undefined
    });
    runtime.bindSurface({
      surface: fakeElement({ left: 0, top: 0, width: 10, height: 10 }) as unknown as HTMLElement
    });
    runtime.input.beginSelectionMarquee({
      pointerId: 31,
      screenPoint: { x: -80, y: -80 },
      modifiers: noModifiers()
    });
    runtime.input.updatePointer({
      pointerId: 31,
      screenPoint: { x: 20, y: 20 },
      modifiers: noModifiers()
    });

    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['overlap-back.png', 'overlap-front.png', 'touch.png']
    });
    runtime.dispose();
  });

  it('prunes Canvas Node Selection when accepting a new Projection', () => {
    const runtime = createMarqueeRuntime();
    runtime.setSelection({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png', 'flow/b.png']
    });

    runtime.manualLayout.acceptProjection({
      canvasId: 'canvas-1',
      nodes: [marqueeNode('flow/b.png', 150, 150)],
      edges: [],
      diagnostics: []
    });

    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/b.png']
    });
  });

  it('keeps node pointer interaction in the runtime snapshot', async () => {
    const runtime = createRuntime();
    const snapshots: unknown[] = [];
    const livePointerInteractions: unknown[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot.pointerInteraction));
    runtime.subscribePointerInteraction((state) => livePointerInteractions.push(state));

    runtime.input.beginNodeMove({
      pointerId: 7,
      projectRelativePath: 'flow/a.png',
      screenPoint: { x: 0, y: 0 }
    });
    runtime.input.updatePointer({ pointerId: 7, screenPoint: { x: 5, y: 6 } });
    const finished = await runtime.input.finishPointer({ pointerId: 7 });

    expect(finished).toMatchObject({
      kind: 'move-node',
      pointerId: 7,
      current: { x: 5, y: 6 },
      origins: [{ projectRelativePath: 'flow/a.png', x: 10, y: 20 }]
    });
    expect(livePointerInteractions).toHaveLength(3);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)).toBeUndefined();
  });

  it('preserves a selected group on pointer-down, then applies plain and additive click selection on release', async () => {
    const runtime = createRuntime();
    runtime.setSelection({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png', 'flow/b.png']
    });

    runtime.input.beginNodeMove({
      pointerId: 11,
      projectRelativePath: 'flow/b.png',
      screenPoint: { x: 0, y: 0 },
      modifiers: noModifiers()
    });
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png', 'flow/b.png']
    });
    expect(runtime.getSnapshot().pointerInteraction).toMatchObject({
      kind: 'move-node',
      origins: [
        { projectRelativePath: 'flow/a.png' },
        { projectRelativePath: 'flow/b.png' }
      ]
    });
    await runtime.input.finishPointer({ pointerId: 11, screenPoint: { x: 0, y: 0 } });
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/b.png']
    });

    runtime.setSelection({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png', 'flow/b.png']
    });
    runtime.input.beginNodeMove({
      pointerId: 12,
      projectRelativePath: 'flow/b.png',
      screenPoint: { x: 0, y: 0 },
      modifiers: { ...noModifiers(), shiftKey: true }
    });
    await runtime.input.finishPointer({
      pointerId: 12,
      screenPoint: { x: 0, y: 0 },
      modifiers: { ...noModifiers(), shiftKey: true }
    });
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png']
    });
  });

  it('moves an additive selection as one full batch and restores the original selection on cancel', async () => {
    const submitManualLayout = vi.fn(async () => undefined);
    const base = [
      { ...canvasProjection('flow/a.png', 10).nodes[0]!, y: 20 },
      { ...canvasProjection('flow/b.png', 30).nodes[0]!, y: 40 }
    ];
    const runtime = createCanvasEditorRuntime({
      canvasId: 'canvas-1',
      initialProjection: { canvasId: 'canvas-1', nodes: base, edges: [], diagnostics: [] },
      submitManualLayout,
      selection: { kind: 'nodes', projectRelativePaths: ['flow/a.png'] }
    });

    runtime.input.beginNodeMove({
      pointerId: 13,
      projectRelativePath: 'flow/b.png',
      screenPoint: { x: 0, y: 0 },
      modifiers: { ...noModifiers(), metaKey: true }
    });
    runtime.input.updatePointer({
      pointerId: 13,
      screenPoint: { x: 10, y: 15 },
      modifiers: { ...noModifiers(), metaKey: true }
    });
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png', 'flow/b.png']
    });
    await runtime.input.finishPointer({ pointerId: 13, screenPoint: { x: 10, y: 15 } });
    expect(submitManualLayout).toHaveBeenCalledWith({
      interaction: 'move',
      nodeLayouts: [
        { projectRelativePath: 'flow/a.png', x: 20, y: 35, width: 100, height: 80 },
        { projectRelativePath: 'flow/b.png', x: 40, y: 55, width: 100, height: 80 }
      ]
    });

    runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['flow/a.png'] });
    runtime.input.beginNodeMove({
      pointerId: 14,
      projectRelativePath: 'flow/b.png',
      screenPoint: { x: 0, y: 0 },
      modifiers: { ...noModifiers(), shiftKey: true }
    });
    runtime.input.updatePointer({ pointerId: 14, screenPoint: { x: 10, y: 0 } });
    runtime.input.cancelPointer(14);
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png']
    });
    expect(runtime.manualLayout.getPresentation().layoutOverrides).toEqual([
      { projectRelativePath: 'flow/a.png', x: 20, y: 35, width: 100, height: 80 },
      { projectRelativePath: 'flow/b.png', x: 40, y: 55, width: 100, height: 80 }
    ]);
  });

  it('does not notify broad snapshot subscribers for pointer move drag previews', () => {
    const runtime = createRuntime();
    const snapshots: unknown[] = [];
    runtime.subscribe((snapshot) => snapshots.push(snapshot));
    runtime.input.beginNodeMove({
      pointerId: 7,
      screenPoint: { x: 0, y: 0 },
      projectRelativePath: 'flow/a.png'
    });
    snapshots.length = 0;

    const updated = runtime.input.updatePointer({
      pointerId: 7,
      screenPoint: { x: 20, y: 30 }
    });

    expect(updated).toBe(true);
    expect(snapshots).toEqual([]);
  });

  it('updates directory resize aspect behavior from live modifiers', () => {
    const runtime = createRuntime();

    runtime.input.beginNodeResize({
      pointerId: 9,
      handle: 'se',
      screenPoint: { x: 0, y: 0 },
      projectRelativePath: 'assets',
      modifiers: { shiftKey: false }
    });

    expect(runtime.getSnapshot().pointerInteraction).toMatchObject({
      kind: 'resize-node',
      preserveAspect: false,
      node: { projectRelativePath: 'assets', nodeKind: 'directory' }
    });

    runtime.input.updatePointer({
      pointerId: 9,
      screenPoint: { x: 30, y: 40 },
      modifiers: { shiftKey: true }
    });

    expect(runtime.getSnapshot().pointerInteraction).toMatchObject({
      kind: 'resize-node',
      preserveAspect: true
    });
  });

  it('starts a later drag from the Manual Layout geometry currently presented to the user', async () => {
    const runtime = createCanvasEditorRuntime({
      canvasId: 'canvas-1',
      initialProjection: canvasProjection('flow/a.png', 0),
      submitManualLayout: async () => undefined
    });

    runtime.input.beginNodeMove({
      pointerId: 1,
      projectRelativePath: 'flow/a.png',
      screenPoint: { x: 0, y: 0 }
    });
    runtime.input.updatePointer({ pointerId: 1, screenPoint: { x: 20, y: 0 } });
    await runtime.input.finishPointer({ pointerId: 1 });

    runtime.input.beginNodeMove({
      pointerId: 2,
      projectRelativePath: 'flow/a.png',
      screenPoint: { x: 20, y: 0 }
    });
    expect(runtime.manualLayout.getPresentation().layoutOverrides).toEqual([
      { projectRelativePath: 'flow/a.png', x: 20, y: 0, width: 100, height: 80 }
    ]);

    runtime.input.updatePointer({ pointerId: 2, screenPoint: { x: 25, y: 0 } });
    expect(runtime.manualLayout.getPresentation().layoutOverrides).toEqual([
      { projectRelativePath: 'flow/a.png', x: 25, y: 0, width: 100, height: 80 }
    ]);
  });

  it('invalidates Manual Layout presentation when its Runtime submission rejects', async () => {
    const request = deferred<void>();
    const submitManualLayout = vi.fn(() => request.promise);
    const runtime = createCanvasEditorRuntime({
      canvasId: 'canvas-1',
      initialProjection: canvasProjection('flow/a.png', 0),
      submitManualLayout
    });
    const rejections: boolean[] = [];
    runtime.manualLayout.subscribeRejection(() => rejections.push(true));
    runtime.input.beginNodeMove({
      pointerId: 1,
      projectRelativePath: 'flow/a.png',
      screenPoint: { x: 0, y: 0 }
    });
    runtime.input.updatePointer({ pointerId: 1, screenPoint: { x: 20, y: 0 } });

    const submission = runtime.input.finishPointer({ pointerId: 1 });
    expect(submitManualLayout).toHaveBeenCalledOnce();
    expect(runtime.manualLayout.getPresentation().layoutOverrides).toHaveLength(1);

    request.reject(new Error('layout write failed'));
    await expect(submission).rejects.toThrow('layout write failed');
    expect(rejections).toEqual([true]);
    expect(runtime.manualLayout.getPresentation().layoutOverrides).toEqual([]);
  });
});

function canvasProjection(projectRelativePath: string, x: number) {
  return {
    canvasId: 'canvas-1',
    nodes: [{
      projectRelativePath,
      nodeKind: 'file' as const,
      mediaKind: 'image' as const,
      x,
      y: 0,
      width: 100,
      height: 80,
      z: 1,
      availability: {
        state: 'available' as const,
        size: 100,
        mimeType: 'image/png',
        fileUrl: `/files/${projectRelativePath}`,
        revision: 'rev'
      }
    }],
    edges: [],
    diagnostics: []
  };
}

function createRuntime(input?: {
  camera?: { x: number; y: number; z: number };
}) {
  return createCanvasEditorRuntime({
    canvasId: 'canvas-1',
    initialProjection: {
      canvasId: 'canvas-1',
      nodes: [
        { ...canvasProjection('flow/a.png', 10).nodes[0]!, y: 20 },
        { ...canvasProjection('flow/b.png', 30).nodes[0]!, y: 40 },
        {
          projectRelativePath: 'assets',
          nodeKind: 'directory' as const,
          x: 10,
          y: 20,
          width: 1800,
          height: 640,
          z: 1,
          availability: {
            state: 'available' as const,
            size: 100,
            mimeType: 'application/octet-stream',
            fileUrl: '/files/assets',
            revision: 'rev'
          }
        }
      ],
      edges: [],
      diagnostics: []
    },
    submitManualLayout: async () => undefined,
    ...input
  });
}

function createMarqueeRuntime() {
  return createCanvasEditorRuntime({
    canvasId: 'canvas-1',
    initialProjection: {
      canvasId: 'canvas-1',
      nodes: [
        marqueeNode('flow/a.png', 20, 20),
        marqueeNode('flow/b.png', 150, 150)
      ],
      edges: [],
      diagnostics: []
    },
    submitManualLayout: async () => undefined
  });
}

function marqueeNode(projectRelativePath: string, x: number, y: number) {
  return {
    ...canvasProjection(projectRelativePath, x).nodes[0]!,
    x,
    y,
    width: 40,
    height: 40
  };
}

function noModifiers() {
  return { shiftKey: false, metaKey: false, ctrlKey: false };
}

function controllableAnimationFrames() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    request(callback: FrameRequestCallback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id: number) {
      callbacks.delete(id);
    },
    step(timestamp: number) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) {
        callback(timestamp);
      }
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

function installBrowserRuntime(input: {
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
} = {}): () => void {
  const originalWindow = globalThis.window;
  const originalResizeObserver = globalThis.ResizeObserver;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: input.requestAnimationFrame ?? ((callback: FrameRequestCallback) => (
        Number(globalThis.setTimeout(() => callback(0), 0))
      )),
      cancelAnimationFrame: input.cancelAnimationFrame ?? ((id: number) => {
        globalThis.clearTimeout(id);
      }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: class {
      observe(): void {}
      disconnect(): void {}
    }
  });
  return () => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: originalWindow
      });
    }
    if (originalResizeObserver === undefined) {
      Reflect.deleteProperty(globalThis, 'ResizeObserver');
    } else {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: originalResizeObserver
      });
    }
  };
}
