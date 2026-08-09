import { describe, expect, it, vi } from 'vitest';
import type { CanvasProjection, ProjectedCanvasNode } from './CanvasScene.js';
import { createCanvasScenePresentation } from './CanvasScenePresentation.js';

describe('CanvasScenePresentation', () => {
  it('does not inspect unrelated base z values during unchanged-selection drag frames', () => {
    let unrelatedZReads = 0;
    const unrelated = node('b.png', 400, 0, 1);
    Object.defineProperty(unrelated, 'z', {
      configurable: true,
      enumerable: true,
      get: () => {
        unrelatedZReads += 1;
        return 1;
      }
    });
    const scene = createCanvasScenePresentation({
      projection: projection([node('a.png', 0, 0, 0), unrelated]),
      presentation: { layoutOverrides: [], selectedProjectRelativePaths: ['a.png'] }
    });
    unrelatedZReads = 0;

    scene.applyPresentation({
      layoutOverrides: [{ projectRelativePath: 'a.png', x: 410, y: 0, width: 100, height: 100 }],
      selectedProjectRelativePaths: ['a.png']
    });

    expect(unrelatedZReads).toBe(0);
    expect(scene.getPresentedNodes().get('a.png')!.z).toBeGreaterThan(
      scene.getPresentedNodes().get('b.png')!.z
    );
  });

  it('recomputes Selection Raise once when authoritative occlusion order changes', () => {
    const scene = createCanvasScenePresentation({
      projection: projection([node('a.png', 0, 0, 0), node('b.png', 400, 0, 1)]),
      presentation: { layoutOverrides: [], selectedProjectRelativePaths: ['a.png'] }
    });

    scene.acceptCanvasStateChange({ nodeStates: [], occlusionOrder: ['b.png'] });

    expect(scene.getPresentedNodes().get('a.png')!.z).toBeGreaterThan(
      scene.getPresentedNodes().get('b.png')!.z
    );
  });

  it('rebuilds Selection Raise ranks from replacement Projection membership', () => {
    const createSelectedScene = (nodes: ProjectedCanvasNode[]) => createCanvasScenePresentation({
      projection: projection(nodes),
      presentation: { layoutOverrides: [], selectedProjectRelativePaths: ['a.png'] }
    });
    const smallProjectionNodes = () => [
      node('a.png', 0, 0, 0),
      node('b.png', 400, 0, 1)
    ];
    const largeProjectionNodes = () => [
      ...smallProjectionNodes(),
      node('c.png', 800, 0, 2),
      node('d.png', 1_200, 0, 3),
      node('e.png', 1_600, 0, 4)
    ];

    const shrinkingScene = createSelectedScene(largeProjectionNodes());
    shrinkingScene.setProjection(
      projection(smallProjectionNodes()),
      { layoutOverrides: [], selectedProjectRelativePaths: ['a.png'] }
    );
    const freshSmallScene = createSelectedScene(smallProjectionNodes());

    const growingScene = createSelectedScene(smallProjectionNodes());
    growingScene.setProjection(
      projection(largeProjectionNodes()),
      { layoutOverrides: [], selectedProjectRelativePaths: ['a.png'] }
    );
    const freshLargeScene = createSelectedScene(largeProjectionNodes());

    expect(shrinkingScene.getPresentedNodes().get('a.png')!.z).toBe(
      freshSmallScene.getPresentedNodes().get('a.png')!.z
    );
    expect(growingScene.getPresentedNodes().get('a.png')!.z).toBe(
      freshLargeScene.getPresentedNodes().get('a.png')!.z
    );
  });

  it('raises newly selected nodes without inspecting unrelated Projection nodes', () => {
    let unrelatedPathReads = 0;
    const unrelated = node('unrelated.png', 800, 0, 2);
    Object.defineProperty(unrelated, 'projectRelativePath', {
      configurable: true,
      enumerable: true,
      get: () => {
        unrelatedPathReads += 1;
        return 'unrelated.png';
      }
    });
    const scene = createCanvasScenePresentation({
      projection: projection([
        node('a.png', 0, 0, 0),
        node('b.png', 400, 0, 1),
        unrelated
      ]),
      presentation: { layoutOverrides: [], selectedProjectRelativePaths: ['a.png'] }
    });
    const retainedAZ = scene.getPresentedNodes().get('a.png')!.z;
    unrelatedPathReads = 0;

    const update = scene.applyPresentation({
      layoutOverrides: [],
      selectedProjectRelativePaths: ['a.png', 'b.png']
    });

    expect(unrelatedPathReads).toBe(0);
    expect(update.nodeLayouts.map((layout) => layout.projectRelativePath)).toEqual(['b.png']);
    expect(scene.getPresentedNodes().get('a.png')!.z).toBe(retainedAZ);
    expect(scene.getPresentedNodes().get('a.png')!.z).toBeGreaterThan(
      scene.getPresentedNodes().get('b.png')!.z
    );
    expect(scene.getPresentedNodes().get('b.png')!.z).toBeGreaterThan(
      scene.getPresentedNodes().get('unrelated.png')!.z
    );
  });

  it('notifies only the changed path and does not publish a membership snapshot', () => {
    const scene = createCanvasScenePresentation({
      projection: projection([node('a.png', 0, 0, 0), node('b.png', 400, 0, 1)]),
      presentation: { layoutOverrides: [], selectedProjectRelativePaths: [] }
    });
    const acceptedA = vi.fn();
    const acceptedB = vi.fn();
    const renderSnapshot = vi.fn();
    scene.subscribeAcceptedNode('a.png', acceptedA);
    scene.subscribeAcceptedNode('b.png', acceptedB);
    scene.subscribeRenderSnapshot(renderSnapshot);

    const update = scene.acceptCanvasStateChange({
      nodeStates: [{
        projectRelativePath: 'a.png',
        state: { manualLayout: { x: 50, y: 60, width: 120, height: 130 } }
      }]
    });

    expect(acceptedA).toHaveBeenCalledOnce();
    expect(acceptedB).not.toHaveBeenCalled();
    expect(renderSnapshot).not.toHaveBeenCalled();
    expect(update.nodeLayouts.map((layout) => layout.projectRelativePath)).toEqual(['a.png']);
  });

  it('restores the retained Automatic Layout baseline when manual layout is removed', () => {
    const manual = {
      ...node('a.png', 50, 60, 0),
      layoutMode: 'manual' as const,
      automaticLayout: { x: 5, y: 6, width: 100, height: 100 }
    };
    const scene = createCanvasScenePresentation({
      projection: projection([manual]),
      presentation: { layoutOverrides: [], selectedProjectRelativePaths: [] }
    });

    scene.acceptCanvasStateChange({
      nodeStates: [{ projectRelativePath: 'a.png', state: null }]
    });

    expect(scene.getAcceptedNode('a.png')).toMatchObject({
      x: 5,
      y: 6,
      width: 100,
      height: 100
    });
    expect(scene.getAcceptedNode('a.png')).not.toHaveProperty('layoutMode');
  });

  it('retires a confirmed draft without repeating geometry or culling work', () => {
    const scene = createCanvasScenePresentation({
      projection: projection([node('a.png', 0, 0, 0)]),
      presentation: {
        layoutOverrides: [{ projectRelativePath: 'a.png', x: 50, y: 60, width: 120, height: 130 }],
        selectedProjectRelativePaths: ['a.png']
      }
    });
    const presentation = vi.fn();
    const renderSnapshot = vi.fn();
    scene.subscribePresentation(presentation);
    scene.subscribeRenderSnapshot(renderSnapshot);

    const accepted = scene.acceptCanvasStateChange({
      nodeStates: [{
        projectRelativePath: 'a.png',
        state: { manualLayout: { x: 50, y: 60, width: 120, height: 130 } }
      }]
    });
    const retired = scene.applyPresentation({
      layoutOverrides: [],
      selectedProjectRelativePaths: ['a.png']
    });

    expect(accepted.geometryChanged).toBe(false);
    expect(retired.geometryChanged).toBe(false);
    expect(presentation).not.toHaveBeenCalled();
    expect(renderSnapshot).not.toHaveBeenCalled();
  });
});

function projection(nodes: ProjectedCanvasNode[]): CanvasProjection {
  return { nodes, edges: [], occlusionOrder: [] };
}

function node(path: string, x: number, y: number, z: number): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    displayName: path,
    nodeKind: 'file',
    mediaKind: 'image',
    availability: { state: 'missing', message: 'fixture' },
    x,
    y,
    width: 100,
    height: 100,
    z,
    automaticLayout: { x, y, width: 100, height: 100 }
  };
}
