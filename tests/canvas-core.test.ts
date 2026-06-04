import { describe, expect, it } from 'vitest';
import {
  CANVAS_FEEDBACK_MARKS,
  CANVAS_DOCUMENT_SCHEMA_VERSION,
  canvasNodeLayerOrderTopFirst,
  createCanvasDocument,
  createEmptyCanvasFeedbackDocument,
  normalizeCanvasFeedbackDocument,
  projectCanvas,
  reconcileCanvasNodeElements,
  updateCanvasFeedbackEntry,
  updateCanvasNodeLayers,
  updateCanvasNodeLayouts,
  type CanvasDesiredNode,
  type CanvasDocument,
  type CanvasNodeAvailability,
  type CanvasNodeElement
} from '@axis/canvas-core';

describe('canvas-core', () => {
  it('creates Canvas documents with nodeElements', () => {
    const canvas = createCanvasDocument({ id: 'main', title: 'Main' });

    expect(canvas).toMatchObject({
      schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
      id: 'main',
      title: 'Main',
      nodeElements: [],
      annotations: [],
      preferences: { showDiagnostics: true }
    });
  });

  it('projects nodes and undirected structure edges', () => {
    const canvas = createCanvasWithNodes([
      { projectRelativePath: 'image-production', nodeKind: 'directory', x: 0, y: 0, width: 240, height: 96 },
      { projectRelativePath: 'image-production/cover.md', nodeKind: 'file', mediaKind: 'text', x: 320, y: 0, width: 420, height: 280 }
    ]);

    const projection = projectCanvas({
      canvas,
      structureEdges: [{
        id: 'image-production--image-production/cover.md',
        sourceProjectRelativePath: 'image-production',
        targetProjectRelativePath: 'image-production/cover.md'
      }],
      nodeAvailability: availableNode
    });

    expect(projection.nodes.map((node) => node.projectRelativePath)).toEqual([
      'image-production',
      'image-production/cover.md'
    ]);
    expect(projection.edges).toEqual([{
      id: 'image-production--image-production/cover.md',
      sourceProjectRelativePath: 'image-production',
      targetProjectRelativePath: 'image-production/cover.md'
    }]);
  });

  it('marks moved and resized nodes manual and uses projectRelativePath identity', () => {
    const canvas = createCanvasWithNodes([
      { projectRelativePath: 'flow/a.md', nodeKind: 'file', mediaKind: 'text', x: 0, y: 0, width: 420, height: 280 },
      { projectRelativePath: 'flow/b.md', nodeKind: 'file', mediaKind: 'text', x: 600, y: 0, width: 420, height: 280, locked: true }
    ]);

    const moved = updateCanvasNodeLayouts(canvas, {
      nodeLayouts: [
        { projectRelativePath: 'flow/a.md', x: 20, y: 30, width: 500, height: 320 },
        { projectRelativePath: 'flow/b.md', x: 50, y: 60, width: 500, height: 320 }
      ]
    });

    expect(moved.nodeElements.find((node) => node.projectRelativePath === 'flow/a.md')).toMatchObject({
      x: 20,
      y: 30,
      width: 500,
      height: 320,
      layoutMode: 'manual'
    });
    expect(moved.nodeElements.find((node) => node.projectRelativePath === 'flow/b.md')).toMatchObject({
      x: 600,
      y: 0,
      width: 420,
      height: 280,
      locked: true
    });
  });

  it('assigns deterministic node layer state and projects all nodes by z order', () => {
    const canvas = createCanvasWithNodes([
      { projectRelativePath: 'flow/bottom.png', nodeKind: 'file', mediaKind: 'image', x: 0, y: 0, width: 100, height: 100 },
      { projectRelativePath: 'flow/top.png', nodeKind: 'file', mediaKind: 'image', x: 20, y: 20, width: 100, height: 100 }
    ]);
    const hidden = updateCanvasNodeLayers(canvas, {
      nodeLayers: [{ projectRelativePath: 'flow/bottom.png', visible: false }]
    });
    const projection = projectCanvas({ canvas: hidden, nodeAvailability: availableNode });

    expect(canvas.nodeElements).toMatchObject([
      { projectRelativePath: 'flow/bottom.png', z: 0, visible: true, locked: false },
      { projectRelativePath: 'flow/top.png', z: 1, visible: true, locked: false }
    ]);
    expect(projection.nodes.map((node) => node.projectRelativePath)).toEqual(['flow/bottom.png', 'flow/top.png']);
    expect(projection.nodes.find((node) => node.projectRelativePath === 'flow/bottom.png')).toMatchObject({ visible: false });
    expect(canvasNodeLayerOrderTopFirst(canvas)).toEqual(['flow/top.png', 'flow/bottom.png']);
  });

  it('applies requested top-first layer order without reversing it', () => {
    const canvas = createCanvasWithNodes([
      { projectRelativePath: 'flow/a.png', nodeKind: 'file', mediaKind: 'image', x: 0, y: 0, width: 100, height: 100 },
      { projectRelativePath: 'flow/b.png', nodeKind: 'file', mediaKind: 'image', x: 0, y: 0, width: 100, height: 100 },
      { projectRelativePath: 'flow/c.png', nodeKind: 'file', mediaKind: 'image', x: 0, y: 0, width: 100, height: 100 }
    ]);

    const reordered = updateCanvasNodeLayers(canvas, {
      nodeProjectRelativePathsTopFirst: ['flow/a.png', 'flow/b.png', 'flow/c.png']
    });

    expect(canvasNodeLayerOrderTopFirst(reordered)).toEqual(['flow/a.png', 'flow/b.png', 'flow/c.png']);
  });

  it('reconciles desired file tree nodes with compact tree layout and preserves manual nodes', () => {
    const desired: CanvasDesiredNode[] = [
      { projectRelativePath: 'image-production', nodeKind: 'directory' },
      { projectRelativePath: 'image-production/01-prompts', nodeKind: 'directory' },
      { projectRelativePath: 'image-production/01-prompts/cover.md', nodeKind: 'file', mediaKind: 'text' },
      { projectRelativePath: 'image-production/02-output', nodeKind: 'directory' },
      { projectRelativePath: 'image-production/02-output/final.png', nodeKind: 'file', mediaKind: 'image' }
    ];

    const reconciled = reconcileCanvasNodeElements({
      existing: [{
        projectRelativePath: 'image-production/02-output/final.png',
        nodeKind: 'file',
        mediaKind: 'image',
        x: 900,
        y: 700,
        width: 640,
        height: 360,
        z: 5,
        visible: true,
        locked: false,
        layoutMode: 'manual'
      }],
      desired,
      layoutSizeForNode: layoutSize
    });

    expect(reconciled.map((node) => node.projectRelativePath)).toEqual(desired.map((node) => node.projectRelativePath));
    expect(reconciled.find((node) => node.projectRelativePath === 'image-production')).toMatchObject({
      nodeKind: 'directory',
      x: 0
    });
    expect(reconciled.find((node) => node.projectRelativePath === 'image-production/01-prompts')).toMatchObject({
      nodeKind: 'directory',
      x: 340
    });
    expect(reconciled.find((node) => node.projectRelativePath === 'image-production/01-prompts/cover.md')).toMatchObject({
      x: 680,
      width: 420,
      height: 280
    });
    expect(reconciled.find((node) => node.projectRelativePath === 'image-production/02-output/final.png')).toMatchObject({
      x: 900,
      y: 700,
      width: 640,
      height: 360,
      layoutMode: 'manual'
    });
  });

  it('spaces automatic file-tree columns by enlarged fixed-size nodes', () => {
    const desired: CanvasDesiredNode[] = [
      { projectRelativePath: 'flow', nodeKind: 'directory' },
      { projectRelativePath: 'flow/prompts', nodeKind: 'directory' },
      { projectRelativePath: 'flow/prompts/brief.md', nodeKind: 'file', mediaKind: 'text' }
    ];

    const reconciled = reconcileCanvasNodeElements({
      existing: [],
      desired,
      layoutSizeForNode: (node) => node.nodeKind === 'directory'
        ? { width: 2400, height: 960 }
        : { width: 4200, height: 2800 }
    });

    expect(reconciled.find((node) => node.projectRelativePath === 'flow')).toMatchObject({
      x: 0,
      width: 2400,
      height: 960
    });
    expect(reconciled.find((node) => node.projectRelativePath === 'flow/prompts')).toMatchObject({
      x: 2500,
      width: 2400,
      height: 960
    });
    expect(reconciled.find((node) => node.projectRelativePath === 'flow/prompts/brief.md')).toMatchObject({
      x: 5000,
      width: 4200,
      height: 2800
    });
  });

  it('lays out grouped direct child files in one horizontal row', () => {
    const desired: CanvasDesiredNode[] = [
      { projectRelativePath: 'flow', nodeKind: 'directory' },
      { projectRelativePath: 'flow/outputs', nodeKind: 'directory' },
      { projectRelativePath: 'flow/outputs/a.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'flow/outputs/b.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'flow/outputs/c.png', nodeKind: 'file', mediaKind: 'image' }
    ];

    const reconciled = reconcileCanvasNodeElements({
      existing: [],
      desired,
      layoutGroups: [{
        parentProjectRelativePath: 'flow/outputs',
        memberProjectRelativePaths: [
          'flow/outputs/a.png',
          'flow/outputs/b.png',
          'flow/outputs/c.png'
        ]
      }],
      layoutSizeForNode: layoutSize
    });

    expect(reconciled.find((node) => node.projectRelativePath === 'flow/outputs/a.png')).toMatchObject({ x: 680, y: 0 });
    expect(reconciled.find((node) => node.projectRelativePath === 'flow/outputs/b.png')).toMatchObject({ x: 1400, y: 0 });
    expect(reconciled.find((node) => node.projectRelativePath === 'flow/outputs/c.png')).toMatchObject({ x: 2120, y: 0 });
  });

  it('vertically centers different-height grouped direct child files in one horizontal row', () => {
    const desired: CanvasDesiredNode[] = [
      { projectRelativePath: 'flow', nodeKind: 'directory' },
      { projectRelativePath: 'flow/outputs', nodeKind: 'directory' },
      { projectRelativePath: 'flow/outputs/a.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'flow/outputs/b.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'flow/outputs/c.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'flow/outputs/notes.md', nodeKind: 'file', mediaKind: 'text' }
    ];

    const reconciled = reconcileCanvasNodeElements({
      existing: [],
      desired,
      layoutGroups: [{
        parentProjectRelativePath: 'flow/outputs',
        memberProjectRelativePaths: [
          'flow/outputs/a.png',
          'flow/outputs/b.png',
          'flow/outputs/c.png'
        ]
      }],
      layoutSizeForNode: (node) => {
        if (node.projectRelativePath === 'flow/outputs/a.png') {
          return { width: 640, height: 360 };
        }
        if (node.projectRelativePath === 'flow/outputs/b.png') {
          return { width: 420, height: 280 };
        }
        if (node.projectRelativePath === 'flow/outputs/c.png') {
          return { width: 100, height: 100 };
        }
        return layoutSize(node);
      }
    });

    const a = reconciled.find((node) => node.projectRelativePath === 'flow/outputs/a.png')!;
    const b = reconciled.find((node) => node.projectRelativePath === 'flow/outputs/b.png')!;
    const c = reconciled.find((node) => node.projectRelativePath === 'flow/outputs/c.png')!;
    const notes = reconciled.find((node) => node.projectRelativePath === 'flow/outputs/notes.md')!;

    expect(a).toMatchObject({ x: 680, y: 0, width: 640, height: 360 });
    expect(b).toMatchObject({ x: 1400, y: 40, width: 420, height: 280 });
    expect(c).toMatchObject({ x: 1900, y: 130, width: 100, height: 100 });
    expect(a.y + a.height / 2).toBe(180);
    expect(b.y + b.height / 2).toBe(180);
    expect(c.y + c.height / 2).toBe(180);
    expect(notes).toMatchObject({ x: 680, y: 440, width: 420, height: 280 });
  });

  it('places ungrouped children below horizontal group blocks', () => {
    const desired: CanvasDesiredNode[] = [
      { projectRelativePath: 'flow', nodeKind: 'directory' },
      { projectRelativePath: 'flow/outputs', nodeKind: 'directory' },
      { projectRelativePath: 'flow/outputs/a.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'flow/outputs/b.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'flow/outputs/notes.md', nodeKind: 'file', mediaKind: 'text' }
    ];

    const reconciled = reconcileCanvasNodeElements({
      existing: [],
      desired,
      layoutGroups: [{
        parentProjectRelativePath: 'flow/outputs',
        memberProjectRelativePaths: [
          'flow/outputs/a.png',
          'flow/outputs/b.png'
        ]
      }],
      layoutSizeForNode: layoutSize
    });

    expect(reconciled.find((node) => node.projectRelativePath === 'flow/outputs/a.png')).toMatchObject({ x: 680, y: 0 });
    expect(reconciled.find((node) => node.projectRelativePath === 'flow/outputs/b.png')).toMatchObject({ x: 1400, y: 0 });
    expect(reconciled.find((node) => node.projectRelativePath === 'flow/outputs/notes.md')).toMatchObject({ x: 680, y: 440 });
  });

  it('keeps manual grouped nodes at their actual layout while reserving their theoretical slot', () => {
    const existing = [{
      projectRelativePath: 'flow/outputs/b.png',
      nodeKind: 'file' as const,
      mediaKind: 'image' as const,
      x: 999,
      y: 888,
      width: 777,
      height: 666,
      z: 10,
      visible: true,
      locked: false,
      layoutMode: 'manual' as const
    }];
    const desired: CanvasDesiredNode[] = [
      { projectRelativePath: 'flow', nodeKind: 'directory' },
      { projectRelativePath: 'flow/outputs', nodeKind: 'directory' },
      { projectRelativePath: 'flow/outputs/a.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'flow/outputs/b.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'flow/outputs/c.png', nodeKind: 'file', mediaKind: 'image' }
    ];

    const reconciled = reconcileCanvasNodeElements({
      existing,
      desired,
      layoutGroups: [{
        parentProjectRelativePath: 'flow/outputs',
        memberProjectRelativePaths: [
          'flow/outputs/a.png',
          'flow/outputs/b.png',
          'flow/outputs/c.png'
        ]
      }],
      layoutSizeForNode: layoutSize
    });

    expect(reconciled.find((node) => node.projectRelativePath === 'flow/outputs/a.png')).toMatchObject({ x: 680, y: 0 });
    expect(reconciled.find((node) => node.projectRelativePath === 'flow/outputs/b.png')).toMatchObject({
      x: 999,
      y: 888,
      width: 777,
      height: 666,
      layoutMode: 'manual'
    });
    expect(reconciled.find((node) => node.projectRelativePath === 'flow/outputs/c.png')).toMatchObject({ x: 2120, y: 0 });
  });

  it('assigns unique layer values when new automatic nodes are inserted before existing nodes', () => {
    const existing = createCanvasWithNodes([
      { projectRelativePath: 'flow', nodeKind: 'directory', x: 0, y: 0, width: 240, height: 96 },
      { projectRelativePath: 'flow/z.png', nodeKind: 'file', mediaKind: 'image', x: 0, y: 0, width: 100, height: 100 }
    ]).nodeElements;
    const desired: CanvasDesiredNode[] = [
      { projectRelativePath: 'flow', nodeKind: 'directory' },
      { projectRelativePath: 'flow/a.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'flow/z.png', nodeKind: 'file', mediaKind: 'image' }
    ];

    const reconciled = reconcileCanvasNodeElements({
      existing,
      desired,
      layoutSizeForNode: () => ({ width: 100, height: 100 })
    });

    expect(new Set(reconciled.map((node) => node.z)).size).toBe(reconciled.length);
    expect(reconciled.find((node) => node.projectRelativePath === 'flow')).toMatchObject({ z: 0 });
    expect(reconciled.find((node) => node.projectRelativePath === 'flow/z.png')).toMatchObject({ z: 1 });
  });

  it('removes nodes absent from the desired projection', () => {
    const reconciled = reconcileCanvasNodeElements({
      existing: [
        node('flow/a.md', { mediaKind: 'text' }),
        node('flow/removed.md', { mediaKind: 'text' })
      ],
      desired: [{ projectRelativePath: 'flow/a.md', nodeKind: 'file', mediaKind: 'text' }],
      layoutSizeForNode: layoutSize
    });

    expect(reconciled.map((item) => item.projectRelativePath)).toEqual(['flow/a.md']);
  });

  it('normalizes Canvas feedback marks as selected-only fixed-order values', () => {
    const normalized = normalizeCanvasFeedbackDocument({
      schemaVersion: 1,
      updatedAt: '2026-05-26T12:00:00.000Z',
      entries: {
        'flow/a.png': {
          projectRelativePath: 'flow/a.png',
          marks: ['needs_revision', 'like', 'like', 'check'],
          note: '  Needs hand cleanup.  ',
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      }
    });

    expect(CANVAS_FEEDBACK_MARKS).toEqual([
      'like',
      'dislike',
      'check',
      'cross',
      'pending',
      'important',
      'needs_revision'
    ]);
    expect(normalized.entries['flow/a.png']).toEqual({
      projectRelativePath: 'flow/a.png',
      marks: ['like', 'check', 'needs_revision'],
      note: 'Needs hand cleanup.',
      updatedAt: '2026-05-26T12:00:00.000Z'
    });
  });

  it('updates and deletes Canvas feedback entries as current state', () => {
    const empty = createEmptyCanvasFeedbackDocument('2026-05-26T12:00:00.000Z');
    const added = updateCanvasFeedbackEntry(empty, {
      projectRelativePath: 'flow/a.png',
      marks: ['cross', 'like'],
      note: '  Keep alternate.  '
    }, '2026-05-26T12:01:00.000Z');

    expect(added).toEqual({
      schemaVersion: 1,
      updatedAt: '2026-05-26T12:01:00.000Z',
      entries: {
        'flow/a.png': {
          projectRelativePath: 'flow/a.png',
          marks: ['like', 'cross'],
          note: 'Keep alternate.',
          updatedAt: '2026-05-26T12:01:00.000Z'
        }
      }
    });

    const cleared = updateCanvasFeedbackEntry(added, {
      projectRelativePath: 'flow/a.png',
      marks: [],
      note: '   '
    }, '2026-05-26T12:02:00.000Z');

    expect(cleared).toEqual({
      schemaVersion: 1,
      updatedAt: '2026-05-26T12:02:00.000Z',
      entries: {}
    });
  });

  it('rejects invalid Canvas feedback documents', () => {
    expect(() => normalizeCanvasFeedbackDocument({
      schemaVersion: 1,
      updatedAt: '2026-05-26T12:00:00.000Z',
      entries: {
        'flow/a.png': {
          projectRelativePath: 'flow/a.png',
          marks: ['unknown'],
          note: '',
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      }
    })).toThrow('Invalid Canvas feedback mark: unknown');

    expect(() => normalizeCanvasFeedbackDocument({
      schemaVersion: 1,
      updatedAt: '2026-05-26T12:00:00.000Z',
      entries: {
        'flow/a.png': {
          projectRelativePath: 'flow/b.png',
          marks: ['like'],
          note: '',
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      }
    })).toThrow('Canvas feedback entry key must match projectRelativePath: flow/a.png');

    expect(() => updateCanvasFeedbackEntry(
      createEmptyCanvasFeedbackDocument('2026-05-26T12:00:00.000Z'),
      { projectRelativePath: '../outside.png', marks: ['like'], note: '' },
      '2026-05-26T12:01:00.000Z'
    )).toThrow('Invalid Canvas feedback project-relative path: ../outside.png');
  });
});

function createCanvasWithNodes(nodes: Array<Partial<CanvasNodeElement> & Pick<CanvasNodeElement, 'projectRelativePath' | 'nodeKind' | 'x' | 'y' | 'width' | 'height'>>): CanvasDocument {
  return {
    ...createCanvasDocument({ id: 'main', title: 'Main' }),
    nodeElements: nodes.map((item, index) => ({
      z: index,
      visible: true,
      locked: false,
      ...item
    }))
  };
}

function node(projectRelativePath: string, input: Partial<CanvasNodeElement> = {}): CanvasNodeElement {
  return {
    projectRelativePath,
    nodeKind: input.nodeKind ?? 'file',
    mediaKind: input.mediaKind,
    x: input.x ?? 0,
    y: input.y ?? 0,
    width: input.width ?? 420,
    height: input.height ?? 280,
    z: input.z ?? 0,
    visible: input.visible ?? true,
    locked: input.locked ?? false,
    ...(input.layoutMode ? { layoutMode: input.layoutMode } : {})
  };
}

function availableNode(): CanvasNodeAvailability {
  return {
    state: 'available',
    size: 0,
    mimeType: 'text/plain',
    fileUrl: '/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/flow?v=rev',
    revision: '1'
  };
}

function layoutSize(node: CanvasDesiredNode): { width: number; height: number } {
  if (node.nodeKind === 'directory') {
    return { width: 240, height: 96 };
  }
  if (node.mediaKind === 'image') {
    return { width: 640, height: 360 };
  }
  return { width: 420, height: 280 };
}
