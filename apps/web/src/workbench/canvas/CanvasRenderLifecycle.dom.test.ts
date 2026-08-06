import type { CanvasProjection, ProjectedCanvasNode } from './CanvasScene.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasPerfMonitor } from './CanvasPerfMonitor.js';
import {
  createCanvasRenderLifecycle,
  type CanvasRenderLifecycle
} from './CanvasRenderLifecycle.js';
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
  it('mounts every current Canvas node regardless of the camera', () => {
    const fixture = createFixture({
      nodes: [
        directoryNode('near', 0, 0, 1),
        directoryNode('far', 5000, 0, 2)
      ]
    });

    expect([...fixture.runtime.scene.getRenderSnapshot().nodesByPath.keys()]).toEqual(['far', 'near']);
    const sceneBeforePan = fixture.runtime.scene.getRenderSnapshot();
    const listener = vi.fn();
    const unsubscribe = fixture.runtime.scene.subscribeRenderSnapshot(listener);

    fixture.runtime.camera.setCamera({ x: -5000, y: 0, z: 1 });
    fixture.frames[0]?.(0);

    expect(fixture.runtime.scene.getRenderSnapshot()).toBe(sceneBeforePan);
    expect(listener).not.toHaveBeenCalled();
    expect(fixture.lifecycle.previewDistanceSquaredForNode('near'))
      .toBeLessThan(fixture.lifecycle.previewDistanceSquaredForNode('far'));
    unsubscribe();
  });

  it('culls mounted node shells through direct display writes while panning', () => {
    const fixture = createFixture({
      nodes: [
        directoryNode('near', 0, 0, 1),
        directoryNode('far', 5000, 0, 2)
      ]
    });
    const near = document.createElement('div');
    const far = document.createElement('div');
    const unregisterNear = fixture.stageRuntime.registerNodeShell('near', near);
    const unregisterFar = fixture.stageRuntime.registerNodeShell('far', far);

    expect(near.style.display).toBe('block');
    expect(far.style.display).toBe('none');

    fixture.runtime.camera.setCamera({ x: -5000, y: 0, z: 1 });
    fixture.frames[0]?.(0);

    expect(near.style.display).toBe('none');
    expect(far.style.display).toBe('block');
    expect(fixture.runtime.scene.getRenderSnapshot().nodesByPath.size).toBe(2);

    unregisterFar();
    unregisterNear();
  });

  it('writes the live camera immediately and coalesces direct viewport culling per frame', () => {
    const fixture = createFixture();
    const setCamera = vi.spyOn(fixture.stageRuntime, 'setCamera');

    fixture.runtime.camera.setCamera({ x: -200, y: 0, z: 1 });
    fixture.runtime.camera.setCamera({ x: -400, y: 0, z: 1 });

    expect(setCamera).toHaveBeenLastCalledWith({ x: -400, y: 0, z: 1 });
    expect(fixture.frames).toHaveLength(1);
  });

  it('publishes the final viewport for resource ordering only when camera movement becomes idle', () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const listener = vi.fn();
    fixture.lifecycle.subscribePreviewOrder(listener);
    const beforePan = fixture.lifecycle.getPreviewOrderSnapshot();

    fixture.runtime.camera.setCamera({ x: -200, y: 0, z: 1 });
    fixture.frames[0]?.(0);

    expect(fixture.lifecycle.getPreviewOrderSnapshot()).toBe(beforePan);
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CANVAS_CAMERA_IDLE_MS);

    expect(fixture.lifecycle.getPreviewOrderSnapshot().x).toBe(200);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('writes Manual Layout geometry directly without publishing a new React snapshot', () => {
    const fixture = createFixture({
      nodes: [
        directoryNode('back', 0, 0, 0),
        directoryNode('front', 20, 0, 1)
      ]
    });
    const back = document.createElement('div');
    const unregisterBack = fixture.stageRuntime.registerNodeShell('back', back);
    const sceneBeforeMove = fixture.runtime.scene.getRenderSnapshot();
    const listener = vi.fn();
    const unsubscribe = fixture.runtime.scene.subscribeRenderSnapshot(listener);

    fixture.runtime.input.beginNodeMove({
      pointerId: 2,
      projectRelativePath: 'back',
      screenPoint: { x: 0, y: 0 }
    });
    fixture.runtime.input.updatePointerInteraction({
      pointerId: 2,
      screenPoint: { x: 5, y: 0 }
    });

    expect([...fixture.runtime.scene.getRenderSnapshot().nodesByPath.keys()]).toEqual(['back', 'front']);
    expect(fixture.runtime.scene.getRenderSnapshot()).toBe(sceneBeforeMove);
    expect(fixture.runtime.scene.getRenderSnapshot().nodesByPath.get('back')?.x).toBe(0);
    expect(back.style.transform).toBe('translate(5px, 0px)');
    expect(back.style.zIndex).toBe('2');
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    unregisterBack();
  });

  it('invalidates queued viewport work when the Projection changes', () => {
    const fixture = createFixture({ nodes: [directoryNode('old', 0, 0, 1)] });

    fixture.runtime.camera.setCamera({ x: -20, y: 0, z: 1 });
    fixture.runtime.acceptProjection(projection([directoryNode('new', 0, 0, 1)]));

    expect(fixture.canceledFrames).toEqual([1]);
    expect([...fixture.runtime.scene.getRenderSnapshot().nodesByPath.keys()]).toEqual(['new']);
    fixture.frames[0]?.(0);
    expect([...fixture.runtime.scene.getRenderSnapshot().nodesByPath.keys()]).toEqual(['new']);
  });

  it('records viewport culling and idle publication without rebuilding the scene', () => {
    vi.useFakeTimers();
    const monitor = createCanvasPerfMonitor();
    const fixture = createFixture({ perfMonitor: monitor });
    const buildsBeforePan = counterCount(monitor, 'render-snapshot-build');

    fixture.runtime.camera.setCamera({ x: -20, y: 0, z: 1 });
    fixture.runtime.camera.setCamera({ x: -40, y: 0, z: 1 });
    fixture.frames[0]?.(0);
    vi.advanceTimersByTime(CANVAS_CAMERA_IDLE_MS);

    const names = monitor.getTrace().events
      .filter((event) => event.kind === 'counter')
      .map((event) => event.name);
    expect(names).toContain('viewport-cull-queued');
    expect(names).toContain('viewport-idle-publish');
    expect(counterCount(monitor, 'render-snapshot-build')).toBe(buildsBeforePan);
  });
});

function counterCount(monitor: ReturnType<typeof createCanvasPerfMonitor>, name: string): number {
  return monitor.getTrace().events.filter((event) => event.kind === 'counter' && event.name === name).length;
}

interface CanvasRenderLifecycleFixture {
  runtime: CanvasEditorRuntime;
  stageRuntime: CanvasStageRuntime;
  lifecycle: CanvasRenderLifecycle;
  frames: FrameRequestCallback[];
  canceledFrames: number[];
  dispose(): void;
}

function createFixture(input: {
  nodes?: ProjectedCanvasNode[] | undefined;
  perfMonitor?: ReturnType<typeof createCanvasPerfMonitor> | undefined;
} = {}): CanvasRenderLifecycleFixture {
  const frames: FrameRequestCallback[] = [];
  const canceledFrames: number[] = [];
  const initialProjection = projection(input.nodes ?? [directoryNode('near', 0, 0, 1)]);
  const runtime = createCanvasEditorRuntime({
    initialProjection,
    submitManualLayout: async () => undefined
  });
  const stageRuntime = createCanvasStageRuntime();
  const lifecycle = createCanvasRenderLifecycle({
    runtime,
    stageRuntime,
    perfMonitor: input.perfMonitor,
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: (handle) => canceledFrames.push(handle)
  });
  const detachLifecycle = lifecycle.attach();
  let disposed = false;
  const fixture: CanvasRenderLifecycleFixture = {
    runtime,
    stageRuntime,
    lifecycle,
    frames,
    canceledFrames,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      detachLifecycle();
      stageRuntime.dispose();
      runtime.dispose();
      fixtures.delete(fixture);
    }
  };
  fixtures.add(fixture);
  return fixture;
}

function projection(nodes: ProjectedCanvasNode[]): CanvasProjection {
  return { nodes, edges: [], diagnostics: [] };
}

function directoryNode(path: string, x: number, y: number, z: number): ProjectedCanvasNode {
  return {
    nodeKind: 'directory',
    projectRelativePath: path,
    displayName: path,
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
