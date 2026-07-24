import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasPerfMonitor, type CanvasPerfMonitor } from './CanvasPerfMonitor.js';
import {
  createCanvasRenderLifecycle,
  type CanvasRenderLifecycle
} from './CanvasRenderLifecycle.js';
import { createCanvasVisibilityController } from './CanvasVisibilityController.js';
import {
  createCanvasEditorRuntime,
  type CanvasEditorRuntime
} from './runtime/CanvasEditorRuntime.js';
import {
  createCanvasStageRuntime,
  type CanvasStageRuntime
} from './runtime/CanvasStageRuntime.js';
import { CANVAS_CAMERA_IDLE_MS } from './runtime/canvasCamera.js';

const fixtures = new Set<CanvasRenderLifecycleFixture>();

afterEach(() => {
  for (const fixture of [...fixtures]) {
    fixture.dispose();
  }
  vi.useRealTimers();
});

describe('CanvasRenderLifecycle', () => {
  it('keeps a newer selection when an older moving frame fires', () => {
    const fixture = createFixture({
      nodes: [
        directoryNode('near', 0, 0, 1),
        directoryNode('far', 5000, 0, 2)
      ]
    });

    expect(fixture.lifecycle.getSnapshot().nodesByPath.has('far')).toBe(false);

    fixture.runtime.camera.setCamera({ x: -20, y: 0, z: 1 });
    fixture.runtime.setSelection({ kind: 'node', projectRelativePath: 'far' });

    expect(fixture.canceledFrames).toEqual([1]);
    expect(fixture.lifecycle.getSnapshot().nodesByPath.has('far')).toBe(true);

    fixture.frames[0]?.(0);

    expect(fixture.lifecycle.getSnapshot().nodesByPath.has('far')).toBe(true);
  });

  it('coalesces camera movement and recomputes from the latest camera', () => {
    const fixture = createFixture();

    fixture.runtime.camera.setCamera({ x: -1800, y: 0, z: 1 });
    fixture.runtime.camera.setCamera({ x: -4000, y: 0, z: 1 });

    expect(fixture.frames).toHaveLength(1);

    fixture.frames[0]?.(0);

    expect(fixture.lifecycle.getSnapshot().visibleRect.x).toBe(4000);
  });

  it('invalidates a moving frame when the Canvas Projection changes', () => {
    const fixture = createFixture({
      nodes: [directoryNode('old', 0, 0, 1)]
    });

    fixture.runtime.camera.setCamera({ x: -20, y: 0, z: 1 });
    fixture.lifecycle.acceptProjection(projection([
      directoryNode('new', 0, 0, 1)
    ]));

    expect(fixture.canceledFrames).toEqual([1]);
    expect([...fixture.lifecycle.getSnapshot().nodesByPath.keys()]).toEqual(['new']);

    fixture.frames[0]?.(0);

    expect([...fixture.lifecycle.getSnapshot().nodesByPath.keys()]).toEqual(['new']);
  });

  it('keeps an active drag mounted when an older moving frame fires', () => {
    const fixture = createFixture({
      nodes: [
        directoryNode('near', 0, 0, 1),
        directoryNode('far', 5000, 0, 2)
      ]
    });

    fixture.runtime.camera.setCamera({ x: -20, y: 0, z: 1 });
    fixture.runtime.input.beginNodeMove({
      pointerId: 1,
      projectRelativePath: 'far',
      start: { x: 5000, y: 0 },
      selection: { kind: 'node', projectRelativePath: 'far' }
    });

    expect(fixture.canceledFrames).toEqual([1]);
    expect(fixture.lifecycle.getSnapshot().nodesByPath.has('far')).toBe(true);

    fixture.frames[0]?.(0);

    expect(fixture.lifecycle.getSnapshot().nodesByPath.has('far')).toBe(true);
  });

  it('flushes the latest camera immediately when movement becomes idle', () => {
    vi.useFakeTimers();
    const fixture = createFixture();

    fixture.runtime.camera.setCamera({ x: -20, y: 0, z: 1 });

    expect(fixture.lifecycle.getSnapshot().visibleRect.x).not.toBe(20);

    vi.advanceTimersByTime(CANVAS_CAMERA_IDLE_MS);

    expect(fixture.canceledFrames).toEqual([1]);
    expect(fixture.lifecycle.getSnapshot().visibleRect.x).toBe(20);

    fixture.frames[0]?.(0);

    expect(fixture.lifecycle.getSnapshot().visibleRect.x).toBe(20);
  });

  it('invalidates a moving frame when the Canvas surface size changes', () => {
    const fixture = createFixture();
    const surface = document.createElement('div');
    surface.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      right: 4000,
      bottom: 3000,
      left: 0,
      width: 4000,
      height: 3000,
      toJSON: () => ({})
    });

    fixture.runtime.camera.setCamera({ x: -20, y: 0, z: 1 });
    const unbindSurface = fixture.runtime.bindSurface({ surface });

    expect(fixture.canceledFrames).toEqual([1]);
    expect(fixture.lifecycle.getSnapshot().visibleRect).toMatchObject({
      x: 20,
      width: 4000,
      height: 3000
    });

    fixture.frames[0]?.(0);

    expect(fixture.lifecycle.getSnapshot().visibleRect).toMatchObject({
      x: 20,
      width: 4000,
      height: 3000
    });

    unbindSurface();
  });

  it('removes rejected Manual Layout presentation from the render snapshot', async () => {
    const fixture = createFixture({
      submitManualLayout: async () => {
        throw new Error('layout rejected');
      }
    });

    fixture.runtime.input.beginNodeMove({
      pointerId: 1,
      projectRelativePath: 'near',
      start: { x: 0, y: 0 },
      selection: { kind: 'node', projectRelativePath: 'near' }
    });
    fixture.runtime.input.updatePointer({
      pointerId: 1,
      point: { x: 100, y: 0 }
    });

    expect(fixture.lifecycle.getSnapshot().nodesByPath.get('near')?.x).toBe(100);

    const finishPointer = fixture.runtime.input.finishPointer({
      pointerId: 1,
      point: { x: 100, y: 0 }
    });
    fixture.runtime.camera.setCamera({ x: -20, y: 0, z: 1 });

    expect(fixture.frames).toHaveLength(1);

    await expect(finishPointer).rejects.toThrow('layout rejected');

    expect(fixture.canceledFrames).toEqual([1]);
    expect(fixture.lifecycle.getSnapshot().nodesByPath.get('near')?.x).toBe(0);

    fixture.frames[0]?.(0);

    expect(fixture.lifecycle.getSnapshot().nodesByPath.get('near')?.x).toBe(0);
  });

  it('writes the live camera to the stage before the scheduled render refresh', () => {
    const fixture = createFixture();
    const setCamera = vi.spyOn(fixture.stageRuntime, 'setCamera');
    const renderSnapshotBeforeCameraMove = fixture.lifecycle.getSnapshot();

    fixture.runtime.camera.setCamera({ x: -350, y: 0, z: 1 });

    expect(setCamera).toHaveBeenCalledWith({ x: -350, y: 0, z: 1 });
    expect(fixture.frames).toHaveLength(1);
    expect(fixture.lifecycle.getSnapshot()).toBe(renderSnapshotBeforeCameraMove);
  });

  it('cancels pending work on detach and resynchronizes current state on reattach', () => {
    const fixture = createFixture({
      nodes: [
        directoryNode('near', 0, 0, 1),
        directoryNode('far', 5000, 0, 2)
      ]
    });

    fixture.runtime.camera.setCamera({ x: -20, y: 0, z: 1 });
    fixture.detach();
    fixture.runtime.setSelection({ kind: 'node', projectRelativePath: 'far' });
    fixture.frames[0]?.(0);

    expect(fixture.canceledFrames).toEqual([1]);
    expect(fixture.lifecycle.getSnapshot().nodesByPath.has('far')).toBe(false);

    fixture.attach();

    expect(fixture.lifecycle.getSnapshot().nodesByPath.has('far')).toBe(true);
  });

  it('records coalesced moving work and the idle flush under its lifecycle source', () => {
    vi.useFakeTimers();
    const monitor = createCanvasPerfMonitor();
    const fixture = createFixture({ perfMonitor: monitor });

    fixture.runtime.camera.setCamera({ x: -20, y: 0, z: 1 });
    fixture.runtime.camera.setCamera({ x: -40, y: 0, z: 1 });
    fixture.frames[0]?.(0);
    vi.advanceTimersByTime(CANVAS_CAMERA_IDLE_MS);

    expect(monitor.getTrace().events.filter((event) => (
      event.kind === 'counter'
      && (event.name === 'render-moving-queued' || event.name === 'render-idle-flush')
    ))).toEqual([
      expect.objectContaining({
        kind: 'counter',
        source: 'CanvasRenderLifecycle',
        name: 'render-moving-queued'
      }),
      expect.objectContaining({
        kind: 'counter',
        source: 'CanvasRenderLifecycle',
        name: 'render-idle-flush'
      })
    ]);
  });
});

interface CanvasRenderLifecycleFixture {
  runtime: CanvasEditorRuntime;
  stageRuntime: CanvasStageRuntime;
  lifecycle: CanvasRenderLifecycle;
  frames: FrameRequestCallback[];
  canceledFrames: number[];
  attach(): void;
  detach(): void;
  dispose(): void;
}

function createFixture(input: {
  nodes?: ProjectedCanvasNode[] | undefined;
  submitManualLayout?: CanvasEditorRuntimeFixtureInput['submitManualLayout'] | undefined;
  perfMonitor?: CanvasPerfMonitor | undefined;
} = {}): CanvasRenderLifecycleFixture {
  const frames: FrameRequestCallback[] = [];
  const canceledFrames: number[] = [];
  const initialProjection = projection(input.nodes ?? [directoryNode('near', 0, 0, 1)]);
  const runtime = createCanvasEditorRuntime({
    canvasId: initialProjection.canvasId,
    initialProjection,
    submitManualLayout: input.submitManualLayout ?? (async () => undefined)
  });
  const stageRuntime = createCanvasStageRuntime();
  const lifecycle = createCanvasRenderLifecycle({
    projection: initialProjection,
    runtime,
    stageRuntime,
    visibilityController: createCanvasVisibilityController({ stageRuntime }),
    perfMonitor: input.perfMonitor,
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: (handle) => canceledFrames.push(handle)
  });
  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  const fixture: CanvasRenderLifecycleFixture = {
    runtime,
    stageRuntime,
    lifecycle,
    frames,
    canceledFrames,
    attach() {
      unsubscribe ??= lifecycle.subscribe(() => undefined);
    },
    detach() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      fixture.detach();
      stageRuntime.dispose();
      runtime.dispose();
      fixtures.delete(fixture);
    }
  };
  fixture.attach();
  fixtures.add(fixture);
  return fixture;
}

type CanvasEditorRuntimeFixtureInput = Parameters<typeof createCanvasEditorRuntime>[0];

function projection(nodes: ProjectedCanvasNode[]): CanvasProjection {
  return {
    canvasId: 'canvas',
    nodes,
    edges: [],
    diagnostics: []
  };
}

function directoryNode(path: string, x: number, y: number, z: number): ProjectedCanvasNode {
  return {
    nodeKind: 'directory',
    projectRelativePath: path,
    x,
    y,
    width: 100,
    height: 100,
    z,
    availability: {
      state: 'available',
      fileUrl: '',
      revision: '1',
      size: 0,
      mimeType: 'inode/directory'
    }
  };
}
