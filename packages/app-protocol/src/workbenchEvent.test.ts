import { describe, expect, it } from 'vitest';
import {
  decodeWorkbenchEvent,
  decodeWorkbenchProjectConnectionFrame,
  isRecognizedWorkbenchEventFrame,
  isRecognizedWorkbenchProjectConnectionFrame
} from './index.js';

describe('Workbench event decoding', () => {
  it('owns the complete project.bound baseline contract', () => {
    const frame = {
      type: 'project.bound',
      project: {
        projectId: 'project-1',
        projectRevision: 1,
        snapshot: snapshotFixture()
      },
      workingCopies: { text: {}, feedback: {} }
    };

    expect(decodeWorkbenchProjectConnectionFrame(frame)).toEqual(frame);
    expect(isRecognizedWorkbenchProjectConnectionFrame({
      ...frame,
      project: { ...frame.project, snapshot: {} }
    })).toBe(true);
    expect(decodeWorkbenchProjectConnectionFrame({
      ...frame,
      project: { ...frame.project, snapshot: {} }
    })).toBeUndefined();
    expect(decodeWorkbenchProjectConnectionFrame({
      ...frame,
      project: { ...frame.project, projectId: 'project-2' }
    })).toBeUndefined();
    expect(decodeWorkbenchProjectConnectionFrame({
      ...frame,
      workingCopies: {
        text: {},
        feedback: {
          'pin-1': {
            itemId: 'pin-1',
            createdAt: '2026-07-23T00:00:00.000Z',
            projectRelativePath: 'clips/demo.mp4',
            kind: 'pin',
            scope: 'file',
            comment: ''
          }
        }
      }
    })).toBeUndefined();
    expect(decodeWorkbenchProjectConnectionFrame({
      ...frame,
      workingCopies: {
        text: {
          'wrong-key.md': {
            projectRelativePath: 'draft.md',
            content: 'draft',
            language: 'markdown',
            baseRevision: 'revision-1'
          }
        },
        feedback: {}
      }
    })).toBeUndefined();
    expect(decodeWorkbenchProjectConnectionFrame({
      ...frame,
      workingCopies: {
        text: {},
        feedback: {
          'pin-2': {
            itemId: 'pin-2',
            createdAt: '2026-07-23T00:00:00.000Z',
            projectRelativePath: 'clips/demo.mp4',
            kind: 'pin',
            scope: 'file',
            geometry: { type: 'point', x: 1.1, y: 0.5 },
            comment: ''
          }
        }
      }
    })).toBeUndefined();
    expect(decodeWorkbenchProjectConnectionFrame({
      ...frame,
      project: {
        ...frame.project,
        snapshot: { ...snapshotWithCanvasTopology(), projections: [] }
      }
    })).toBeUndefined();
    expect(decodeWorkbenchProjectConnectionFrame({
      ...frame,
      workingCopies: {
        text: {},
        feedback: {
          'moment-1': {
            itemId: 'moment-1',
            createdAt: '2026-07-23T00:00:00.000Z',
            projectRelativePath: 'clips/demo.mp4',
            kind: 'comment',
            scope: 'moment',
            momentTimeSeconds: -1,
            comment: ''
          }
        }
      }
    })).toBeUndefined();
  });

  it('accepts a complete revisioned Project snapshot event', () => {
    const event = {
      type: 'project.changed',
      projectId: 'project-1',
      projectRevision: 2,
      snapshot: snapshotFixture()
    };

    expect(decodeWorkbenchEvent(event)).toEqual(event);
  });

  it('recognizes but rejects incomplete authoritative Project payloads', () => {
    const incompleteSnapshot = {
      type: 'project.changed',
      projectId: 'project-1',
      projectRevision: 2,
      snapshot: {}
    };
    const incompleteCanvas = {
      type: 'canvas.changed',
      projectId: 'project-1',
      projectRevision: 2,
      canvas: {},
      projection: {}
    };

    expect(isRecognizedWorkbenchEventFrame(incompleteSnapshot)).toBe(true);
    expect(decodeWorkbenchEvent(incompleteSnapshot)).toBeUndefined();
    expect(decodeWorkbenchEvent(incompleteCanvas)).toBeUndefined();
    expect(decodeWorkbenchEvent({
      type: 'project.changed',
      projectId: 'project-2',
      projectRevision: 2,
      snapshot: snapshotFixture()
    })).toBeUndefined();
    expect(decodeWorkbenchEvent({
      type: 'canvas.changed',
      projectId: 'project-1',
      projectRevision: 2,
      canvas: {
        id: 'canvas-1',
        name: 'Canvas 1',
        nodeElements: [],
        annotations: [],
        preferences: { showDiagnostics: true }
      },
      projection: {
        canvasId: 'canvas-2',
        nodes: [],
        edges: [],
        diagnostics: []
      }
    })).toBeUndefined();
    const duplicateCanvasOrder = snapshotWithCanvasTopology();
    duplicateCanvasOrder.canvasRegistry.canvasOrder = ['canvas-1', 'canvas-1'];
    expect(decodeWorkbenchEvent({
      type: 'project.changed',
      projectId: 'project-1',
      projectRevision: 2,
      snapshot: duplicateCanvasOrder
    })).toBeUndefined();
  });

  it('rejects an invalid revision before it reaches projection acceptance', () => {
    expect(decodeWorkbenchEvent({
      type: 'canvas.feedback.changed',
      projectId: 'project-1',
      projectRevision: 1.5,
      feedback: { updatedAt: '2026-07-23T00:00:00.000Z', entries: {} }
    })).toBeUndefined();
  });

  it('rejects incomplete discriminated Project payload variants', () => {
    const videoNode = {
      projectRelativePath: 'clips/demo.mp4',
      nodeKind: 'file',
      mediaKind: 'video',
      x: 0,
      y: 0,
      width: 640,
      height: 360,
      z: 0
    };
    expect(decodeWorkbenchEvent({
      type: 'canvas.changed',
      projectId: 'project-1',
      projectRevision: 2,
      canvas: {
        id: 'canvas-1',
        name: 'Canvas 1',
        nodeElements: [videoNode],
        annotations: [],
        preferences: { showDiagnostics: true }
      },
      projection: {
        canvasId: 'canvas-1',
        nodes: [{
          ...videoNode,
          availability: {
            state: 'available',
            size: 100,
            mimeType: 'video/mp4',
            fileUrl: '/clips/demo.mp4',
            revision: 'revision-1'
          }
        }],
        edges: [],
        diagnostics: []
      }
    })).toBeUndefined();

    expect(decodeWorkbenchEvent({
      type: 'canvas.feedback.changed',
      projectId: 'project-1',
      projectRevision: 2,
      feedback: {
        updatedAt: '2026-07-23T00:00:00.000Z',
        entries: {
          'clips/demo.mp4': {
            projectRelativePath: 'clips/demo.mp4',
            marks: [],
            nextMomentLabel: 1,
            nextSpatialLabel: 2,
            items: [{
              id: 'pin-1',
              kind: 'pin',
              scope: 'file',
              comment: '',
              createdAt: '2026-07-23T00:00:00.000Z',
              updatedAt: '2026-07-23T00:00:00.000Z'
            }],
            updatedAt: '2026-07-23T00:00:00.000Z'
          }
        }
      }
    })).toBeUndefined();
    expect(decodeWorkbenchEvent({
      type: 'canvas.feedback.changed',
      projectId: 'project-1',
      projectRevision: 2,
      feedback: {
        updatedAt: '2026-07-23T00:00:00.000Z',
        entries: {
          'wrong-key.mp4': {
            projectRelativePath: 'clips/demo.mp4',
            marks: ['like'],
            nextMomentLabel: 1,
            nextSpatialLabel: 1,
            items: [],
            updatedAt: '2026-07-23T00:00:00.000Z'
          }
        }
      }
    })).toBeUndefined();
  });
});

function snapshotFixture() {
  return {
    metadata: {
      project: {
        id: 'project-1',
        name: 'Demo',
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z'
      }
    },
    files: [],
    canvases: [],
    projections: [],
    diagnostics: [],
    canvasRegistry: { status: 'ready', canvasOrder: [] },
    health: {
      projectName: 'Demo',
      canvasCount: 0,
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-07-23T00:00:00.000Z'
    }
  };
}

function snapshotWithCanvasTopology() {
  return {
    ...snapshotFixture(),
    canvases: [{
      id: 'canvas-1',
      name: 'Canvas 1',
      nodeElements: [],
      annotations: [],
      preferences: { showDiagnostics: true }
    }],
    projections: [{
      canvasId: 'canvas-1',
      nodes: [],
      edges: [],
      diagnostics: []
    }],
    canvasRegistry: { status: 'ready', canvasOrder: ['canvas-1'] },
    health: {
      ...snapshotFixture().health,
      canvasCount: 1
    }
  };
}
