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
        bindingId: 'project-1',
        canonicalRoot: '/projects/project-1',
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
      project: { ...frame.project, bindingId: '' }
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
            scope: 'node',
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
            scope: 'node',
            geometry: { type: 'point', x: 1.1, y: 0.5 },
            comment: ''
          }
        }
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
      bindingId: 'project-1',
      projectRevision: 2,
      snapshot: snapshotFixture()
    };

    expect(decodeWorkbenchEvent(event)).toEqual(event);
  });

  it('accepts an authoritative Canvas State delta event', () => {
    const event = {
      type: 'canvas.state.changed',
      bindingId: 'project-1',
      projectRevision: 2,
      change: {
        nodeStates: [{
          projectRelativePath: 'clips/demo.mp4',
          state: {
            manualLayout: { x: 10, y: 20, width: 300, height: 200 }
          }
        }],
        occlusionOrder: ['clips/demo.mp4']
      }
    };

    expect(decodeWorkbenchEvent(event)).toEqual(event);
    expect(decodeWorkbenchEvent({
      ...event,
      change: { ...event.change, unknown: true }
    })).toBeUndefined();
    expect(decodeWorkbenchEvent({
      ...event,
      change: {
        ...event.change,
        nodeStates: [...event.change.nodeStates, event.change.nodeStates[0]]
      }
    })).toBeUndefined();
    expect(decodeWorkbenchEvent({
      ...event,
      change: { nodeStates: [] }
    })).toBeUndefined();
    expect(decodeWorkbenchEvent({
      ...event,
      change: {
        nodeStates: [{ projectRelativePath: '', state: { manualLayout: { x: 1, y: 2, width: 3, height: 4 } } }]
      }
    })).toBeDefined();
  });

  it('keeps browser-owned video presentation facts out of Runtime Canvas resources', () => {
    const resource = {
      projectRelativePath: 'clips/demo.mp4',
      nodeKind: 'file' as const,
      mediaKind: 'video' as const,
      availability: {
        state: 'available' as const,
        size: 42,
        mimeType: 'video/mp4',
        fileUrl: '/api/workbench/bindings/project-1/files/clips/demo.mp4',
        revision: 'sha256:demo'
      }
    };
    const event = projectEventWithCanvasResource(resource);

    expect(decodeWorkbenchEvent(event)).toEqual(event);
    const resolvingEvent = projectEventWithCanvasResource({
      ...resource,
      availability: {
        state: 'resolving',
        size: 42,
        mimeType: 'video/mp4',
        sourceToken: 'source-1'
      }
    });
    expect(decodeWorkbenchEvent(resolvingEvent)).toEqual(resolvingEvent);
    for (const invalid of [
      {
        ...resource,
        availability: { ...resource.availability, extra: true }
      },
      { ...resource, videoPresentation: { kind: 'video', width: 1920, height: 1080, textTracks: [] } },
      {
        projectRelativePath: resource.projectRelativePath,
        nodeKind: resource.nodeKind,
        mediaKind: resource.mediaKind,
        availability: { state: 'missing', message: 'gone', extra: true }
      }
    ]) {
      expect(decodeWorkbenchEvent(projectEventWithCanvasResource(invalid))).toBeUndefined();
    }
  });

  it('admits only video files to Feedback preview maintenance resources', () => {
    const video = {
      projectRelativePath: 'archive/clip.mkv',
      nodeKind: 'file',
      mediaKind: 'video',
      availability: {
        state: 'resolving',
        size: 5,
        mimeType: 'video/x-matroska',
        sourceToken: 'source-video'
      }
    };
    expect(decodeWorkbenchEvent(projectEventWithFeedbackVideoResource(video))).toBeDefined();
    expect(decodeWorkbenchEvent(projectEventWithFeedbackVideoResource({
      ...video,
      mediaKind: 'image'
    }))).toBeUndefined();
    expect(decodeWorkbenchEvent(projectEventWithFeedbackVideoResource({
      projectRelativePath: 'archive',
      nodeKind: 'directory'
    }))).toBeUndefined();
  });

  it('accepts the live Photoshop session and Document projection', () => {
    const event = {
      type: 'photoshop.state.changed',
      revision: 7,
      state: {
        status: 'connected',
        transferActive: false,
        sessions: [{
          pluginSessionId: 'photoshop-session-1',
          hostVersion: '27.9.0',
          placementMimeTypes: [
            'image/png',
            'image/jpeg',
            'image/webp',
            'image/vnd.adobe.photoshop',
            'image/avif'
          ],
          documents: [
            { documentId: 41, title: 'Poster.psd' },
            { documentId: 52, title: 'Poster.psd' }
          ]
        }]
      }
    };

    expect(decodeWorkbenchEvent(event)).toEqual(event);
    expect(decodeWorkbenchEvent({
      ...event,
      state: { sessions: [{ ...event.state.sessions[0], documents: [{ documentId: -1, title: 'Poster.psd' }] }] }
    })).toBeUndefined();
    const { placementMimeTypes: _, ...missingCapabilities } = event.state.sessions[0];
    expect(decodeWorkbenchEvent({
      ...event,
      state: { sessions: [missingCapabilities] }
    })).toBeUndefined();
    for (const placementMimeTypes of [
      [],
      ['image/png', 'image/png'],
      ['image/png', 'image/gif']
    ]) {
      expect(decodeWorkbenchEvent({
        ...event,
        state: {
          sessions: [{ ...event.state.sessions[0], placementMimeTypes }]
        }
      })).toBeUndefined();
    }
    expect(decodeWorkbenchEvent({
      ...event,
      state: {
        sessions: [{ ...event.state.sessions[0], extra: true }]
      }
    })).toBeUndefined();
    for (const state of [
      { status: 'off', transferActive: false, sessions: event.state.sessions },
      { status: 'waiting', transferActive: true, sessions: [] },
      { status: 'connected', transferActive: false, sessions: [] },
      { status: 'unavailable', transferActive: false, sessions: event.state.sessions },
      { status: 'connecting', transferActive: false, sessions: [] }
    ]) {
      expect(decodeWorkbenchEvent({ ...event, state })).toBeUndefined();
    }
  });

  it('recognizes but rejects incomplete authoritative Project payloads', () => {
    const incompleteSnapshot = {
      type: 'project.changed',
      bindingId: 'project-1',
      projectRevision: 2,
      snapshot: {}
    };
    expect(isRecognizedWorkbenchEventFrame(incompleteSnapshot)).toBe(true);
    expect(decodeWorkbenchEvent(incompleteSnapshot)).toBeUndefined();
    expect(decodeWorkbenchEvent({
      type: 'project.changed',
      bindingId: '',
      projectRevision: 2,
      snapshot: snapshotFixture()
    })).toBeUndefined();
    const duplicateDisclosure = snapshotWithCanvasTopology();
    duplicateDisclosure.canvasWorkspace.workspace.expandedDirectories = ['assets', 'assets'];
    expect(decodeWorkbenchEvent({
      type: 'project.changed',
      bindingId: 'project-1',
      projectRevision: 2,
      snapshot: duplicateDisclosure
    })).toBeUndefined();
  });

  it('accepts the exact unavailable Canvas Workspace variant', () => {
    const snapshot = snapshotFixture();
    snapshot.canvasWorkspace = {
      status: 'unavailable' as const,
      code: 'canvas_workspace_invalid' as const,
      message: 'Canvas workspace JSON is invalid.'
    };
    expect(decodeWorkbenchEvent({
      type: 'project.changed',
      bindingId: 'project-1',
      projectRevision: 2,
      snapshot
    })).toBeDefined();
    expect(decodeWorkbenchEvent({
      type: 'project.changed',
      bindingId: 'project-1',
      projectRevision: 2,
      snapshot: {
        ...snapshot,
        canvasWorkspace: { ...snapshot.canvasWorkspace, workspace: {} }
      }
    })).toBeUndefined();
  });

  it('rejects an invalid revision before it reaches projection acceptance', () => {
    expect(decodeWorkbenchEvent({
      type: 'canvas.feedback.changed',
      bindingId: 'project-1',
      projectRevision: 1.5,
      feedback: { updatedAt: '2026-07-23T00:00:00.000Z', entries: {} }
    })).toBeUndefined();
  });

  it('rejects incomplete discriminated Project payload variants', () => {
    expect(decodeWorkbenchEvent({
      type: 'canvas.feedback.changed',
      bindingId: 'project-1',
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
              scope: 'node',
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
      bindingId: 'project-1',
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
    canonicalRoot: '/projects/project-1',
    canvasWorkspace: {
      status: 'available' as const,
      workspace: {
        canonicalRoot: '/projects/project-1',
        ...emptyCanvasState()
      },
      canvasResources: {
        resources: []
      },
      feedbackVideoResources: {
        resources: []
      }
    },
    projectTree: [],
    diagnostics: [],
    health: {
      projectName: 'Demo',
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-07-23T00:00:00.000Z'
    }
  };
}

function projectEventWithCanvasResource(resource: unknown) {
  const snapshot = snapshotFixture();
  return {
    type: 'project.changed',
    bindingId: 'project-1',
    projectRevision: 2,
    snapshot: {
      ...snapshot,
      canvasWorkspace: {
        ...snapshot.canvasWorkspace,
        canvasResources: { resources: [resource] }
      }
    }
  };
}

function projectEventWithFeedbackVideoResource(resource: unknown) {
  const snapshot = snapshotFixture();
  return {
    type: 'project.changed',
    bindingId: 'project-1',
    projectRevision: 2,
    snapshot: {
      ...snapshot,
      canvasWorkspace: {
        ...snapshot.canvasWorkspace,
        feedbackVideoResources: { resources: [resource] }
      }
    }
  };
}

function snapshotWithCanvasTopology() {
  return snapshotFixture();
}

function emptyCanvasState() {
  return {
    expandedDirectories: [],
    nodeStates: {},
    occlusionOrder: []
  };
}
