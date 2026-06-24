import { describe, expect, it } from 'vitest';
import { createCanvasVisibilityController } from './CanvasVisibilityController';

describe('CanvasVisibilityController', () => {
  it('writes mounted node visibility from culling state and skips unchanged values', () => {
    const writes: Array<{ path: string; visible: boolean }> = [];
    const controller = createCanvasVisibilityController({
      stageRuntime: {
        setNodeVisible: (path, visible) => writes.push({ path, visible })
      }
    });
    const nodes = new Map([
      ['flow/a.png', node('flow/a.png')],
      ['flow/b.png', node('flow/b.png')],
      ['flow/c.png', node('flow/c.png')]
    ]);

    controller.sync({
      nodesByPath: nodes,
      culledNodePaths: new Set(['flow/b.png']),
      selectedNodePaths: new Set(),
      activeNodePaths: new Set()
    });
    controller.sync({
      nodesByPath: nodes,
      culledNodePaths: new Set(['flow/b.png']),
      selectedNodePaths: new Set(),
      activeNodePaths: new Set()
    });

    expect(writes).toEqual([
      { path: 'flow/a.png', visible: true },
      { path: 'flow/b.png', visible: false },
      { path: 'flow/c.png', visible: true }
    ]);
  });

  it('hides mounted image nodes after they pan outside the virtual render area', () => {
    const writes: Array<{ path: string; visible: boolean }> = [];
    const controller = createCanvasVisibilityController({
      stageRuntime: {
        setNodeVisible: (path, visible) => writes.push({ path, visible })
      }
    });
    const mountedImages = new Map([
      ['flow/a.png', node('flow/a.png')],
      ['flow/b.png', node('flow/b.png')]
    ]);

    controller.sync({
      nodesByPath: mountedImages,
      culledNodePaths: new Set(),
      selectedNodePaths: new Set(),
      activeNodePaths: new Set()
    });
    controller.sync({
      nodesByPath: mountedImages,
      culledNodePaths: new Set(['flow/a.png', 'flow/b.png']),
      selectedNodePaths: new Set(),
      activeNodePaths: new Set()
    });
    controller.sync({
      nodesByPath: mountedImages,
      culledNodePaths: new Set(),
      selectedNodePaths: new Set(),
      activeNodePaths: new Set()
    });

    expect(writes).toEqual([
      { path: 'flow/a.png', visible: true },
      { path: 'flow/b.png', visible: true },
      { path: 'flow/a.png', visible: false },
      { path: 'flow/b.png', visible: false },
      { path: 'flow/a.png', visible: true },
      { path: 'flow/b.png', visible: true }
    ]);
  });

  it('hides culled mounted nodes while the camera is moving', () => {
    const writes: Array<{ path: string; visible: boolean }> = [];
    const controller = createCanvasVisibilityController({
      stageRuntime: {
        setNodeVisible: (path, visible) => writes.push({ path, visible })
      }
    });
    const mountedNodes = new Map([
      ['flow/a.txt', node('flow/a.txt')],
      ['flow/b.txt', node('flow/b.txt')]
    ]);

    controller.sync({
      nodesByPath: mountedNodes,
      culledNodePaths: new Set(),
      selectedNodePaths: new Set(),
      activeNodePaths: new Set()
    });
    controller.sync({
      nodesByPath: mountedNodes,
      culledNodePaths: new Set(['flow/b.txt']),
      selectedNodePaths: new Set(),
      activeNodePaths: new Set()
    });
    controller.sync({
      nodesByPath: mountedNodes,
      culledNodePaths: new Set(['flow/b.txt']),
      selectedNodePaths: new Set(),
      activeNodePaths: new Set()
    });

    expect(writes).toEqual([
      { path: 'flow/a.txt', visible: true },
      { path: 'flow/b.txt', visible: true },
      { path: 'flow/b.txt', visible: false }
    ]);
  });

  it('keeps selected and active mounted nodes visible even when culled', () => {
    const writes: Array<{ path: string; visible: boolean }> = [];
    const controller = createCanvasVisibilityController({
      stageRuntime: {
        setNodeVisible: (path, visible) => writes.push({ path, visible })
      }
    });

    controller.sync({
      nodesByPath: new Map([
        ['flow/selected.png', node('flow/selected.png')],
        ['flow/active.png', node('flow/active.png')],
        ['flow/ordinary.png', node('flow/ordinary.png')]
      ]),
      culledNodePaths: new Set(['flow/selected.png', 'flow/active.png', 'flow/ordinary.png']),
      selectedNodePaths: new Set(['flow/selected.png']),
      activeNodePaths: new Set(['flow/active.png'])
    });

    expect(writes).toEqual([
      { path: 'flow/selected.png', visible: true },
      { path: 'flow/active.png', visible: true },
      { path: 'flow/ordinary.png', visible: false }
    ]);
  });

  it('forgets unmounted paths so a later remount writes visibility again', () => {
    const writes: Array<{ path: string; visible: boolean }> = [];
    const controller = createCanvasVisibilityController({
      stageRuntime: {
        setNodeVisible: (path, visible) => writes.push({ path, visible })
      }
    });

    controller.sync({
      nodesByPath: new Map([['flow/a.png', node('flow/a.png')]]),
      culledNodePaths: new Set(),
      selectedNodePaths: new Set(),
      activeNodePaths: new Set()
    });
    controller.sync({
      nodesByPath: new Map(),
      culledNodePaths: new Set(),
      selectedNodePaths: new Set(),
      activeNodePaths: new Set()
    });
    controller.sync({
      nodesByPath: new Map([['flow/a.png', node('flow/a.png')]]),
      culledNodePaths: new Set(),
      selectedNodePaths: new Set(),
      activeNodePaths: new Set()
    });

    expect(writes).toEqual([
      { path: 'flow/a.png', visible: true },
      { path: 'flow/a.png', visible: true }
    ]);
  });
});

function node(projectRelativePath: string): { projectRelativePath: string } {
  return { projectRelativePath };
}
