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
} from '@debrute/canvas-core';

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

  it('projects nodes and derives structure edges from Canvas node paths', () => {
    const canvas = createCanvasWithNodes([
      { projectRelativePath: 'image-production', nodeKind: 'directory', x: 0, y: 0, width: 240, height: 96 },
      { projectRelativePath: 'image-production/generated', nodeKind: 'directory', x: 320, y: 0, width: 240, height: 96 },
      { projectRelativePath: 'image-production/generated/cover.md', nodeKind: 'file', mediaKind: 'text', x: 640, y: 0, width: 420, height: 280 }
    ]);

    const projection = projectCanvas({ canvas, nodeAvailability: availableNode });

    expect(projection.nodes.map((node) => node.projectRelativePath)).toEqual([
      'image-production',
      'image-production/generated',
      'image-production/generated/cover.md'
    ]);
    expect(projection.edges).toEqual([
      {
        id: 'image-production--image-production/generated',
        sourceProjectRelativePath: 'image-production',
        targetProjectRelativePath: 'image-production/generated'
      },
      {
        id: 'image-production/generated--image-production/generated/cover.md',
        sourceProjectRelativePath: 'image-production/generated',
        targetProjectRelativePath: 'image-production/generated/cover.md'
      }
    ]);
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

  it('lays out automatic hierarchy columns by name order without automatic overlaps', () => {
    const desired: CanvasDesiredNode[] = [
      { projectRelativePath: 'outputs/gpt/z.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'prompts/cover.md', nodeKind: 'file', mediaKind: 'text' },
      { projectRelativePath: 'outputs', nodeKind: 'directory' },
      { projectRelativePath: 'outputs/gpt', nodeKind: 'directory' },
      { projectRelativePath: 'outputs/gpt/a.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'prompts', nodeKind: 'directory' }
    ];

    const reconciled = reconcileCanvasNodeElements({
      existing: [],
      desired,
      layoutSizeForNode: layoutSize
    });

    expect(reconciled.map((item) => item.projectRelativePath)).toEqual([
      'outputs',
      'outputs/gpt',
      'outputs/gpt/a.png',
      'outputs/gpt/z.png',
      'prompts',
      'prompts/cover.md'
    ]);
    expect(nodeByPath(reconciled, 'outputs').x).toBe(0);
    expect(nodeByPath(reconciled, 'prompts').x).toBe(0);
    expect(nodeByPath(reconciled, 'outputs/gpt').x).toBe(340);
    expect(nodeByPath(reconciled, 'prompts/cover.md').x).toBe(340);
    expect(nodeByPath(reconciled, 'outputs/gpt/a.png').x).toBe(860);
    expect(nodeByPath(reconciled, 'outputs/gpt/z.png').x).toBe(860);
    expectNoAutomaticOverlaps(reconciled);
  });

  it('lays out row-controlled direct child files in one horizontal row', () => {
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
      layoutRows: [{
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

  it('vertically centers different-height row-controlled direct child files in one horizontal row', () => {
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
      layoutRows: [{
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

  it('places non-row children below horizontal row blocks regardless of path order', () => {
    const desired: CanvasDesiredNode[] = [
      { projectRelativePath: 'flow', nodeKind: 'directory' },
      { projectRelativePath: 'flow/outputs', nodeKind: 'directory' },
      { projectRelativePath: 'flow/outputs/0-notes.md', nodeKind: 'file', mediaKind: 'text' },
      { projectRelativePath: 'flow/outputs/a.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'flow/outputs/b.png', nodeKind: 'file', mediaKind: 'image' }
    ];

    const reconciled = reconcileCanvasNodeElements({
      existing: [],
      desired,
      layoutRows: [{
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
    expect(reconciled.find((node) => node.projectRelativePath === 'flow/outputs/0-notes.md')).toMatchObject({ x: 680, y: 440 });
  });

  it('keeps manual row nodes at their actual layout while reserving their theoretical slot', () => {
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
      layoutRows: [{
        parentProjectRelativePath: 'flow/outputs',
        memberProjectRelativePaths: [
          'flow/outputs/a.png',
          'flow/outputs/b.png',
          'flow/outputs/c.png'
        ]
      }],
      layoutSizeForNode: layoutSize
    });

    expect(nodeByPath(reconciled, 'flow/outputs/a.png')).toMatchObject({ x: 680, y: 0 });
    expect(nodeByPath(reconciled, 'flow/outputs/c.png')).toMatchObject({ x: 2120, y: 0 });
    expect(nodeByPath(reconciled, 'flow/outputs/b.png')).toMatchObject({
      x: 999,
      y: 888,
      width: 777,
      height: 666,
      layoutMode: 'manual'
    });
    expectNoAutomaticOverlaps(reconciled);
  });

  it('rejects invalid horizontal row members instead of silently filtering them', () => {
    const desired: CanvasDesiredNode[] = [
      { projectRelativePath: 'flow', nodeKind: 'directory' },
      { projectRelativePath: 'flow/assets', nodeKind: 'directory' },
      { projectRelativePath: 'flow/assets/a.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'flow/assets/b.png', nodeKind: 'file', mediaKind: 'image' },
      { projectRelativePath: 'flow/assets/folder.png', nodeKind: 'directory' },
      { projectRelativePath: 'flow/other/c.png', nodeKind: 'file', mediaKind: 'image' }
    ];

    expect(() => reconcileCanvasNodeElements({
      existing: [],
      desired,
      layoutRows: [{
        parentProjectRelativePath: 'flow/assets',
        memberProjectRelativePaths: [
          'flow/assets/a.png',
          'flow/assets/b.png',
          'flow/assets/folder.png'
        ]
      }],
      layoutSizeForNode: layoutSize
    })).toThrow('Canvas layout row member must be a file: flow/assets/folder.png');

    expect(() => reconcileCanvasNodeElements({
      existing: [],
      desired,
      layoutRows: [{
        parentProjectRelativePath: 'flow/assets',
        memberProjectRelativePaths: ['flow/other/c.png']
      }],
      layoutSizeForNode: layoutSize
    })).toThrow('Canvas layout row member is not a direct child of its row parent: flow/other/c.png');
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

function automaticNodes(nodes: CanvasNodeElement[]): CanvasNodeElement[] {
  return nodes.filter((item) => item.layoutMode !== 'manual');
}

function expectNoAutomaticOverlaps(nodes: CanvasNodeElement[]): void {
  const automatic = automaticNodes(nodes);
  for (const [index, left] of automatic.entries()) {
    for (const right of automatic.slice(index + 1)) {
      expect(rectanglesOverlap(left, right), `${left.projectRelativePath} overlaps ${right.projectRelativePath}`).toBe(false);
    }
  }
}

function rectanglesOverlap(
  left: Pick<CanvasNodeElement, 'x' | 'y' | 'width' | 'height'>,
  right: Pick<CanvasNodeElement, 'x' | 'y' | 'width' | 'height'>
): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function nodeByPath(nodes: CanvasNodeElement[], projectRelativePath: string): CanvasNodeElement {
  const found = nodes.find((item) => item.projectRelativePath === projectRelativePath);
  if (!found) {
    throw new Error(`Missing Canvas node fixture: ${projectRelativePath}`);
  }
  return found;
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
