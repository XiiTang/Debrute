import { describe, expect, it } from 'vitest';
import { createCanvasVisibilityController } from './CanvasVisibilityController';

describe('CanvasVisibilityController', () => {
  it('writes all mounted node visibility on first sync and only changed paths after that', () => {
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
      selectedNodePaths: [],
      activeNodePaths: []
    });
    controller.sync({
      nodesByPath: nodes,
      culledNodePaths: new Set(['flow/c.png']),
      selectedNodePaths: [],
      activeNodePaths: []
    });

    expect(writes).toEqual([
      { path: 'flow/a.png', visible: true },
      { path: 'flow/b.png', visible: false },
      { path: 'flow/c.png', visible: true },
      { path: 'flow/b.png', visible: true },
      { path: 'flow/c.png', visible: false }
    ]);
  });

  it('toggles only display visibility for mounted image nodes during a pan out and back', () => {
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
      culledNodePaths: new Set(['flow/b.png']),
      selectedNodePaths: [],
      activeNodePaths: []
    });
    controller.sync({
      nodesByPath: mountedImages,
      culledNodePaths: new Set(['flow/a.png']),
      selectedNodePaths: [],
      activeNodePaths: []
    });
    controller.sync({
      nodesByPath: mountedImages,
      culledNodePaths: new Set(['flow/b.png']),
      selectedNodePaths: [],
      activeNodePaths: []
    });

    expect(writes).toEqual([
      { path: 'flow/a.png', visible: true },
      { path: 'flow/b.png', visible: false },
      { path: 'flow/a.png', visible: false },
      { path: 'flow/b.png', visible: true },
      { path: 'flow/a.png', visible: true },
      { path: 'flow/b.png', visible: false }
    ]);
  });

  it('keeps selected and active nodes visible even when they are culled', () => {
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
      selectedNodePaths: ['flow/selected.png'],
      activeNodePaths: ['flow/active.png']
    });

    expect(writes).toEqual([
      { path: 'flow/selected.png', visible: true },
      { path: 'flow/active.png', visible: true },
      { path: 'flow/ordinary.png', visible: false }
    ]);
  });

  it('keeps selected and active nodes display-visible even when culled', () => {
    const writes: Array<{ path: string; visible: boolean }> = [];
    const controller = createCanvasVisibilityController({
      stageRuntime: {
        setNodeVisible: (path, visible) => writes.push({ path, visible })
      }
    });

    controller.sync({
      nodesByPath: new Map([
        ['flow/selected.png', node('flow/selected.png')],
        ['flow/active.png', node('flow/active.png')]
      ]),
      culledNodePaths: new Set(['flow/selected.png', 'flow/active.png']),
      selectedNodePaths: ['flow/selected.png'],
      activeNodePaths: ['flow/active.png']
    });

    expect(writes).toEqual([
      { path: 'flow/selected.png', visible: true },
      { path: 'flow/active.png', visible: true }
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
      selectedNodePaths: [],
      activeNodePaths: []
    });
    controller.sync({
      nodesByPath: new Map(),
      culledNodePaths: new Set(),
      selectedNodePaths: [],
      activeNodePaths: []
    });
    controller.sync({
      nodesByPath: new Map([['flow/a.png', node('flow/a.png')]]),
      culledNodePaths: new Set(),
      selectedNodePaths: [],
      activeNodePaths: []
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
