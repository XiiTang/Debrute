import { describe, expect, it } from 'vitest';
import {
  projectCanvasScene,
  raiseCanvasSelection,
  reconcileCanvasOcclusionOrder,
  type CanvasProjectedRect
} from './CanvasScene.js';

describe('CanvasScene', () => {
  it('projects the structural Project root', () => {
    const result = projectCanvasScene({
      canonicalRoot: '/Users/example/ecommerce',
      resources: {
        canvasId: 'canvas-1',
        resources: [{ projectRelativePath: '', nodeKind: 'directory' }],
        diagnostics: []
      },
      state: { expandedDirectories: [], nodeStates: {}, occlusionOrder: [] },
      measureLabelWidth: () => 100
    });

    expect(result.projection.nodes).toEqual([
      expect.objectContaining({
        projectRelativePath: '',
        displayName: 'ecommerce',
        nodeKind: 'directory',
        width: 1_540,
        height: 480
      })
    ]);
    expect(result.projection.edges).toEqual([]);
  });

  it('projects the root and visible descendants with measured directory widths', () => {
    const result = projectCanvasScene({
      canonicalRoot: '/Users/example/ecommerce',
      resources: {
        canvasId: 'canvas-1',
        resources: [
          { projectRelativePath: '', nodeKind: 'directory' },
          { projectRelativePath: 'assets', nodeKind: 'directory' },
          {
            projectRelativePath: 'assets/cover.png',
            nodeKind: 'file',
            mediaKind: 'image',
            imageDimensions: { width: 800, height: 600 },
            availability: {
              state: 'available',
              size: 10,
              mimeType: 'image/png',
              fileUrl: '/cover.png',
              revision: 'revision-1'
            }
          }
        ],
        diagnostics: []
      },
      state: { expandedDirectories: ['assets'], nodeStates: {}, occlusionOrder: [] },
      measureLabelWidth: (label) => label === 'ecommerce' ? 100 : 50
    });

    expect(result.projection.nodes.map((node) => [
      node.projectRelativePath,
      node.displayName,
      node.width,
      node.height
    ])).toEqual([
      ['', 'ecommerce', 1_540, 480],
      ['assets', 'assets', 1_200, 480],
      ['assets/cover.png', 'cover.png', 800, 600]
    ]);
    expect(result.projection.edges).toEqual([
      expect.objectContaining({ sourceProjectRelativePath: '', targetProjectRelativePath: 'assets' }),
      expect.objectContaining({ sourceProjectRelativePath: 'assets', targetProjectRelativePath: 'assets/cover.png' })
    ]);
  });

  it('overlays manual state and derives overlap-only stacking order', () => {
    const result = projectCanvasScene({
      canonicalRoot: '/project',
      resources: {
        canvasId: 'canvas-1',
        resources: [
          { projectRelativePath: '', nodeKind: 'directory' },
          { projectRelativePath: 'a', nodeKind: 'directory' },
          { projectRelativePath: 'b', nodeKind: 'directory' }
        ],
        diagnostics: []
      },
      state: {
        expandedDirectories: [],
        nodeStates: {
          a: { manualLayout: { x: 0, y: 0, width: 1_200, height: 480 } },
          b: { manualLayout: { x: 100, y: 100, width: 1_200, height: 480 } }
        },
        occlusionOrder: ['a']
      },
      measureLabelWidth: () => 20
    });

    expect(result.occlusionOrder).toEqual(['a', '', 'b']);
    expect(result.projection.nodes.find((node) => node.projectRelativePath === 'b')!.z)
      .toBeGreaterThan(result.projection.nodes.find((node) => node.projectRelativePath === 'a')!.z);
  });

  it('retains order only for overlapping nodes and raises a selection as one stable group', () => {
    const nodes: CanvasProjectedRect[] = [
      { projectRelativePath: 'a', x: 0, y: 0, width: 100, height: 100 },
      { projectRelativePath: 'b', x: 50, y: 50, width: 100, height: 100 },
      { projectRelativePath: 'c', x: 300, y: 300, width: 100, height: 100 }
    ];

    expect(reconcileCanvasOcclusionOrder(['c', 'b', 'a'], nodes)).toEqual(['b', 'a']);
    expect(raiseCanvasSelection(['c', 'b', 'a'], nodes, ['a', 'b'])).toEqual(['b', 'a']);
    expect(raiseCanvasSelection(['c', 'b', 'a'], nodes, ['b'])).toEqual(['a', 'b']);
  });

  it('places direct-child directories vertically before one ordered horizontal file row', () => {
    const result = projectCanvasScene({
      canonicalRoot: '/project',
      resources: {
        canvasId: 'canvas-1',
        resources: [
          { projectRelativePath: '', nodeKind: 'directory' },
          { projectRelativePath: 'folder', nodeKind: 'directory' },
          {
            projectRelativePath: 'wide.png',
            nodeKind: 'file',
            mediaKind: 'image',
            imageDimensions: { width: 800, height: 600 },
            availability: {
              state: 'available',
              size: 10,
              mimeType: 'image/png',
              fileUrl: '/wide.png',
              revision: 'revision-wide'
            }
          },
          {
            projectRelativePath: 'small.png',
            nodeKind: 'file',
            mediaKind: 'image',
            imageDimensions: { width: 400, height: 200 },
            availability: {
              state: 'available',
              size: 10,
              mimeType: 'image/png',
              fileUrl: '/small.png',
              revision: 'revision-small'
            }
          }
        ],
        diagnostics: []
      },
      state: { expandedDirectories: [], nodeStates: {}, occlusionOrder: [] },
      measureLabelWidth: () => 20
    });

    expect(result.projection.nodes.map((node) => [
      node.projectRelativePath,
      node.x,
      node.y,
      node.width,
      node.height
    ])).toEqual([
      ['', 0, 340, 1_200, 480],
      ['folder', 1_300, 0, 1_200, 480],
      ['wide.png', 1_300, 560, 800, 600],
      ['small.png', 2_180, 760, 400, 200]
    ]);
  });
});
