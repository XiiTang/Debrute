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

  it('keeps hidden nodes hidden even when selected or active', () => {
    const writes: Array<{ path: string; visible: boolean }> = [];
    const controller = createCanvasVisibilityController({
      stageRuntime: {
        setNodeVisible: (path, visible) => writes.push({ path, visible })
      }
    });

    controller.sync({
      nodesByPath: new Map([
        ['flow/hidden-selected.png', node('flow/hidden-selected.png', false)],
        ['flow/hidden-active.png', node('flow/hidden-active.png', false)]
      ]),
      culledNodePaths: new Set(),
      selectedNodePaths: ['flow/hidden-selected.png'],
      activeNodePaths: ['flow/hidden-active.png']
    });

    expect(writes).toEqual([
      { path: 'flow/hidden-selected.png', visible: false },
      { path: 'flow/hidden-active.png', visible: false }
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

function node(projectRelativePath: string, visible = true): { projectRelativePath: string; visible: boolean } {
  return { projectRelativePath, visible };
}
