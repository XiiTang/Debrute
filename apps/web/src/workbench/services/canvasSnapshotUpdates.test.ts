import { describe, expect, it } from 'vitest';
import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { CanvasDocument, CanvasProjection } from '@debrute/canvas-core';
import {
  applyCanvasDocumentToWorkbenchSnapshot,
  applyCanvasTextViewportStateToWorkbenchSnapshot
} from './canvasSnapshotUpdates';

describe('canvas snapshot updates', () => {
  it('applies a returned Canvas document to the local snapshot and projection', () => {
    const original = canvasDocument('canvas-1', 10, 20);
    const updated = canvasDocument('canvas-1', 80, 90);
    const snapshot = snapshotFixture({
      canvases: [original],
      projections: [projectionFixture(original, 'rev-a')]
    });

    const next = applyCanvasDocumentToWorkbenchSnapshot(snapshot, updated);

    expect(next.canvases[0]).toBe(updated);
    expect(next.projections[0]?.nodes[0]).toMatchObject({
      projectRelativePath: 'flow/a.png',
      x: 80,
      y: 90,
      availability: {
        state: 'available',
        revision: 'rev-a'
      }
    });
  });

  it('preserves projected video presentation when applying a local Canvas document update', () => {
    const original = videoCanvasDocument('canvas-1', 10, 20);
    const updated = videoCanvasDocument('canvas-1', 80, 90);
    const projection = videoProjectionFixture(original, 'rev-a');
    const snapshot = snapshotFixture({
      canvases: [original],
      projections: [projection]
    });

    const next = applyCanvasDocumentToWorkbenchSnapshot(snapshot, updated);

    expect(next.projections[0]?.nodes[0]).toMatchObject({
      projectRelativePath: 'media/clip.mp4',
      x: 80,
      y: 90,
      videoPresentation: projection.nodes[0]?.videoPresentation
    });
  });

  it('applies text viewport updates to the local snapshot and projection', () => {
    const original = textCanvasDocument('canvas-1');
    const snapshot = snapshotFixture({
      canvases: [original],
      projections: [projectionFixture(original, 'rev-a')]
    });

    const next = applyCanvasTextViewportStateToWorkbenchSnapshot(snapshot, 'canvas-1', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });

    expect(next.canvases[0]?.nodeElements[0]).toMatchObject({
      projectRelativePath: 'notes/readme.md',
      textViewport: { scrollTop: 72, scrollLeft: 9 }
    });
    expect(next.projections[0]?.nodes[0]).toMatchObject({
      projectRelativePath: 'notes/readme.md',
      textViewport: { scrollTop: 72, scrollLeft: 9 },
      availability: {
        state: 'available',
        revision: 'rev-a'
      }
    });
  });

  it('requires the current projection for availability preservation', () => {
    const snapshot = snapshotFixture({
      canvases: [canvasDocument('canvas-1', 10, 20)],
      projections: []
    });

    expect(() => applyCanvasDocumentToWorkbenchSnapshot(
      snapshot,
      canvasDocument('canvas-1', 80, 90)
    )).toThrow('Cannot apply Canvas document canvas-1 without a current projection.');
  });
});

function snapshotFixture(input: {
  canvases: CanvasDocument[];
  projections: CanvasProjection[];
}): WorkbenchProjectSessionSnapshot {
  return {
    metadata: {
      project: {
        id: 'project-1',
        name: 'Project',
        createdAt: '2026-06-11T00:00:00.000Z',
        updatedAt: '2026-06-11T00:00:00.000Z'
      }
    },
    files: [],
    canvases: input.canvases,
    projections: input.projections,
    diagnostics: [],
    canvasRegistry: {
      status: 'ready',
      canvasOrder: input.canvases.map((canvas) => canvas.id)
    },
    health: {
      projectName: 'Project',
      canvasCount: input.canvases.length,
      diagnosticCounts: {
        errors: 0,
        warnings: 0,
        infos: 0
      },
      runtimeDataLocation: '/tmp/debrute',
      checkedAt: '2026-06-11T00:00:00.000Z'
    }
  };
}

function textCanvasDocument(canvasId: string): CanvasDocument {
  return {
    id: canvasId,
    name: canvasId,
    nodeElements: [{
      projectRelativePath: 'notes/readme.md',
      nodeKind: 'file',
      mediaKind: 'text',
      x: 10,
      y: 20,
      width: 420,
      height: 260,
      z: 0
    }],
    annotations: [],
    preferences: {
      showDiagnostics: true
    }
  };
}

function canvasDocument(canvasId: string, x: number, y: number): CanvasDocument {
  return {
    id: canvasId,
    name: canvasId,
    nodeElements: [{
      projectRelativePath: 'flow/a.png',
      nodeKind: 'file',
      mediaKind: 'image',
      x,
      y,
      width: 200,
      height: 120,
      z: 0
    }],
    annotations: [],
    preferences: {
      showDiagnostics: true
    }
  };
}

function projectionFixture(canvas: CanvasDocument, revision: string): CanvasProjection {
  return {
    canvasId: canvas.id,
    nodes: canvas.nodeElements.map((node) => ({
      ...node,
      availability: {
        state: 'available',
        size: 100,
        mimeType: 'image/png',
        fileUrl: `/api/projects/p/files/raw/${node.projectRelativePath}?v=${revision}`,
        revision
      }
    })),
    edges: [],
    diagnostics: []
  };
}

function videoCanvasDocument(canvasId: string, x: number, y: number): CanvasDocument {
  return {
    id: canvasId,
    name: canvasId,
    nodeElements: [{
      projectRelativePath: 'media/clip.mp4',
      nodeKind: 'file',
      mediaKind: 'video',
      x,
      y,
      width: 640,
      height: 360,
      z: 0
    }],
    annotations: [],
    preferences: {
      showDiagnostics: true
    }
  };
}

function videoProjectionFixture(canvas: CanvasDocument, revision: string): CanvasProjection {
  return {
    canvasId: canvas.id,
    nodes: canvas.nodeElements.map((node) => ({
      ...node,
      availability: {
        state: 'available',
        size: 100,
        mimeType: 'video/mp4',
        fileUrl: `/api/projects/p/files/raw/${node.projectRelativePath}?v=${revision}`,
        revision
      },
      videoPresentation: {
        kind: 'video',
        durationSeconds: 5,
        textTracks: []
      }
    })),
    edges: [],
    diagnostics: []
  };
}
