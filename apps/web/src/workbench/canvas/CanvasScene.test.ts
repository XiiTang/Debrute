import { describe, expect, it } from 'vitest';
import {
  projectCanvasHierarchyEdges,
  projectCanvasNodeScene,
  raiseCanvasSelection,
  reconcileCanvasOcclusionOrder,
  type CanvasProjectedRect
} from './CanvasScene';

describe('CanvasScene', () => {
  it('projects the structural Project root', () => {
    const result = projectCanvasNodeScene({
      canonicalRoot: '/Users/example/ecommerce',
      resources: {
        resources: [{ projectRelativePath: '', nodeKind: 'directory' }],
      },
      state: { expandedDirectories: [], nodeStates: {}, occlusionOrder: [] },
      measureGenericIdentityRows: measuredWidths(() => 100)
    });

    expect(result.nodes).toEqual([
      expect.objectContaining({
        projectRelativePath: '',
        displayName: 'ecommerce',
        nodeKind: 'directory',
        folderDisclosure: 'disclosed',
        width: 1_200,
        height: 480
      })
    ]);
    expect(projectCanvasHierarchyEdges(result.nodes)).toEqual([]);
  });

  it('projects the root and visible descendants with measured directory widths', () => {
    const result = projectCanvasNodeScene({
      canonicalRoot: '/Users/example/ecommerce',
      resources: {
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
      },
      state: { expandedDirectories: ['assets'], nodeStates: {}, occlusionOrder: [] },
      measureGenericIdentityRows: measuredWidths((label) => label === 'ecommerce' ? 154 : 50)
    });

    expect(result.nodes.map((node) => [
      node.projectRelativePath,
      node.displayName,
      node.nodeKind === 'directory' ? node.folderDisclosure : undefined,
      node.width,
      node.height
    ])).toEqual([
      ['', 'ecommerce', 'disclosed', 1_540, 480],
      ['assets', 'assets', 'disclosed', 1_200, 480],
      ['assets/cover.png', 'cover.png', undefined, 800, 600]
    ]);
    expect(projectCanvasHierarchyEdges(result.nodes)).toEqual([
      expect.objectContaining({ sourceProjectRelativePath: '', targetProjectRelativePath: 'assets' }),
      expect.objectContaining({ sourceProjectRelativePath: 'assets', targetProjectRelativePath: 'assets/cover.png' })
    ]);
  });

  it('projects a disclosed empty directory independently of visible descendants', () => {
    const result = projectCanvasNodeScene({
      canonicalRoot: '/Users/example/ecommerce',
      resources: {
        resources: [
          { projectRelativePath: '', nodeKind: 'directory' },
          { projectRelativePath: 'empty', nodeKind: 'directory' }
        ]
      },
      state: { expandedDirectories: ['empty'], nodeStates: {}, occlusionOrder: [] },
      measureGenericIdentityRows: measuredWidths(() => 100)
    });

    expect(result.nodes.find((node) => node.projectRelativePath === 'empty')).toMatchObject({
      nodeKind: 'directory',
      folderDisclosure: 'disclosed'
    });
  });

  it('reserves a usable Content Region for unavailable video', () => {
    const result = projectCanvasNodeScene({
      canonicalRoot: '/project',
      resources: {
        resources: [
          { projectRelativePath: '', nodeKind: 'directory' },
          {
            projectRelativePath: 'missing.mp4',
            nodeKind: 'file',
            mediaKind: 'video',
            availability: { state: 'missing', message: 'missing' }
          }
        ]
      },
      state: { expandedDirectories: [], nodeStates: {}, occlusionOrder: [] },
      measureGenericIdentityRows: measuredWidths(() => 20)
    });

    expect(result.nodes.find((node) => node.projectRelativePath === 'missing.mp4')).toMatchObject({
      width: 3_200,
      height: 2_120
    });
  });

  it('adds the title bar above the intrinsic video Content Region', () => {
    const result = projectCanvasNodeScene({
      canonicalRoot: '/project',
      resources: {
        resources: [
          { projectRelativePath: '', nodeKind: 'directory' },
          {
            projectRelativePath: 'clip.mp4',
            nodeKind: 'file',
            mediaKind: 'video',
            availability: {
              state: 'available',
              size: 10,
              mimeType: 'video/mp4',
              fileUrl: '/clip.mp4',
              revision: 'revision-video'
            }
          }
        ]
      },
      state: { expandedDirectories: [], nodeStates: {}, occlusionOrder: [] },
      videoMetadataByPath: {
        'clip.mp4': {
          sourceRevision: 'revision-video',
          metadata: { width: 1_920, height: 1_080 }
        }
      },
      measureGenericIdentityRows: measuredWidths(() => 20)
    });

    expect(result.nodes.find((node) => node.projectRelativePath === 'clip.mp4')).toMatchObject({
      width: 1_920,
      height: 1_400
    });
  });

  it('uses the compact automatic audio size without rewriting Manual Layout', () => {
    const resources = {
      resources: [
        { projectRelativePath: '', nodeKind: 'directory' as const },
        {
          projectRelativePath: 'theme.mp3',
          nodeKind: 'file' as const,
          mediaKind: 'audio' as const,
          availability: {
            state: 'available' as const,
            size: 10,
            mimeType: 'audio/mpeg',
            fileUrl: '/theme.mp3',
            revision: 'revision-audio'
          }
        }
      ]
    };
    const measureGenericIdentityRows = measuredWidths(() => 20);
    const automatic = projectCanvasNodeScene({
      canonicalRoot: '/project',
      resources,
      state: { expandedDirectories: [], nodeStates: {}, occlusionOrder: [] },
      measureGenericIdentityRows
    });
    const manual = projectCanvasNodeScene({
      canonicalRoot: '/project',
      resources,
      state: {
        expandedDirectories: [],
        nodeStates: {
          'theme.mp3': { manualLayout: { x: 900, y: 800, width: 7_000, height: 6_000 } }
        },
        occlusionOrder: []
      },
      measureGenericIdentityRows
    });

    expect(automatic.nodes.find((node) => node.projectRelativePath === 'theme.mp3')).toMatchObject({
      width: 3_200,
      height: 680
    });
    expect(manual.nodes.find((node) => node.projectRelativePath === 'theme.mp3')).toMatchObject({
      x: 900,
      y: 800,
      width: 7_000,
      height: 6_000,
      layoutMode: 'manual'
    });
  });

  it('overlays manual state and derives overlap-only stacking order', () => {
    const measuredLabels: string[][] = [];
    const result = projectCanvasNodeScene({
      canonicalRoot: '/project',
      resources: {
        resources: [
          { projectRelativePath: '', nodeKind: 'directory' },
          { projectRelativePath: 'a', nodeKind: 'directory' },
          { projectRelativePath: 'b', nodeKind: 'directory' }
        ],
      },
      state: {
        expandedDirectories: [],
        nodeStates: {
          a: { manualLayout: { x: 0, y: 0, width: 1_200, height: 480 } },
          b: { manualLayout: { x: 100, y: 100, width: 1_200, height: 480 } }
        },
        occlusionOrder: ['a']
      },
      measureGenericIdentityRows: (labels) => {
        measuredLabels.push([...labels]);
        return new Map(labels.map((label) => [label, 20]));
      }
    });

    expect(measuredLabels).toEqual([['project', 'a', 'b']]);
    expect(result.nodes.find((node) => node.projectRelativePath === 'a')).toMatchObject({
      x: 0,
      y: 0,
      width: 1_200,
      height: 480,
      layoutMode: 'manual'
    });
    expect(result.nodes.find((node) => node.projectRelativePath === 'b')).toMatchObject({
      x: 100,
      y: 100,
      width: 1_200,
      height: 480,
      layoutMode: 'manual'
    });
    expect(result.occlusionOrder).toEqual(['a', '', 'b']);
    expect(result.nodes.find((node) => node.projectRelativePath === 'b')!.z)
      .toBeGreaterThan(result.nodes.find((node) => node.projectRelativePath === 'a')!.z);
  });

  it('keeps Automatic Layout independent of a node manual rectangle', () => {
    const resources = {
      resources: [
        { projectRelativePath: '', nodeKind: 'directory' as const },
        { projectRelativePath: 'a', nodeKind: 'directory' as const },
        { projectRelativePath: 'b', nodeKind: 'directory' as const }
      ]
    };
    const measureGenericIdentityRows = measuredWidths(() => 20);
    const automatic = projectCanvasNodeScene({
      canonicalRoot: '/project',
      resources,
      state: { expandedDirectories: [], nodeStates: {}, occlusionOrder: [] },
      measureGenericIdentityRows
    });
    const manual = projectCanvasNodeScene({
      canonicalRoot: '/project',
      resources,
      state: {
        expandedDirectories: [],
        nodeStates: {
          a: { manualLayout: { x: 9_000, y: 8_000, width: 7_000, height: 6_000 } }
        },
        occlusionOrder: []
      },
      measureGenericIdentityRows
    });

    for (const path of ['', 'b']) {
      const automaticNode = automatic.nodes.find((node) => node.projectRelativePath === path)!;
      expect(manual.nodes.find((node) => node.projectRelativePath === path)).toMatchObject({
        x: automaticNode.x,
        y: automaticNode.y,
        width: automaticNode.width,
        height: automaticNode.height
      });
    }
    expect(manual.nodes.find((node) => node.projectRelativePath === 'a')).toMatchObject({
      x: 9_000,
      y: 8_000,
      width: 7_000,
      height: 6_000,
      layoutMode: 'manual'
    });
  });

  it('retains order only for overlapping nodes and raises a selection as one stable group', () => {
    const nodes: CanvasProjectedRect[] = [
      { projectRelativePath: 'a', x: 0, y: 0, width: 100, height: 100 },
      { projectRelativePath: 'b', x: 50, y: 50, width: 100, height: 100 },
      { projectRelativePath: 'c', x: 300, y: 300, width: 100, height: 100 }
    ];

    expect(reconcileCanvasOcclusionOrder(['c', 'b', 'a'], nodes)).toEqual(['b', 'a']);
    expect(raiseCanvasSelection(['b', 'a'], ['a', 'b'])).toEqual(['b', 'a']);
    expect(raiseCanvasSelection(['b', 'a'], ['b'])).toEqual(['a', 'b']);
    expect(raiseCanvasSelection(['b', 'a'], ['c'])).toEqual(['b', 'a']);
  });

  it('places direct-child directories vertically before one ordered horizontal file row', () => {
    const result = projectCanvasNodeScene({
      canonicalRoot: '/project',
      resources: {
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
      },
      state: { expandedDirectories: [], nodeStates: {}, occlusionOrder: [] },
      measureGenericIdentityRows: measuredWidths(() => 20)
    });

    expect(result.nodes.map((node) => [
      node.projectRelativePath,
      node.nodeKind === 'directory' ? node.folderDisclosure : undefined,
      node.x,
      node.y,
      node.width,
      node.height
    ])).toEqual([
      ['', 'disclosed', 0, 340, 1_200, 480],
      ['folder', 'collapsed', 1_300, 0, 1_200, 480],
      ['wide.png', undefined, 1_300, 560, 800, 600],
      ['small.png', undefined, 2_180, 760, 400, 200]
    ]);
  });
});

function measuredWidths(
  widthForLabel: (label: string) => number
): (labels: readonly string[]) => ReadonlyMap<string, number> {
  return (labels) => new Map(labels.map((label) => [label, widthForLabel(label)]));
}
