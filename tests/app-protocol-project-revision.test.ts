import { describe, expect, it } from 'vitest';
import type {
  LiveProjectsView,
  WorkbenchCanvasDocumentMutationResult,
  WorkbenchCanvasFeedbackMutationResult,
  WorkbenchCanvasManagementResult,
  WorkbenchEvent,
  WorkbenchProjectOpenResult,
  WorkbenchProjectSessionSnapshot,
  WorkbenchProjectTextFileWriteResult
} from '@debrute/app-protocol';

describe('app protocol project revisions', () => {
  it('carries project revisions on project views, mutation results, and project events', () => {
    const snapshot = snapshotFixture();
    const opened: WorkbenchProjectOpenResult = {
      projectId: 'project-live-id',
      projectRevision: 1,
      snapshot
    };
    const live: LiveProjectsView = {
      projects: [{
        projectId: opened.projectId,
        projectRevision: opened.projectRevision,
        snapshot,
        clients: { liveCount: 2 }
      }]
    };
    const canvasResult: WorkbenchCanvasManagementResult = {
      projectId: opened.projectId,
      projectRevision: 2,
      snapshot,
      activeCanvasId: 'canvas-1'
    };
    const textResult: WorkbenchProjectTextFileWriteResult = {
      projectId: opened.projectId,
      projectRevision: 3,
      file: {
        projectRelativePath: 'brief.md',
        content: '# Brief',
        language: 'markdown',
        mimeType: 'text/markdown',
        revision: 'file-rev',
        size: 7,
        mtimeMs: 1
      }
    };
    const documentResult: WorkbenchCanvasDocumentMutationResult = {
      projectId: opened.projectId,
      projectRevision: 4,
      canvas: { id: 'canvas-1', nodeElements: [], annotations: [], preferences: { showDiagnostics: true } },
      projection: { canvasId: 'canvas-1', nodes: [], edges: [], diagnostics: [] }
    };
    const feedbackResult: WorkbenchCanvasFeedbackMutationResult = {
      projectId: opened.projectId,
      projectRevision: 5,
      feedback: { updatedAt: '2026-06-12T00:00:00.000Z', entries: {} }
    };
    const event: WorkbenchEvent = {
      type: 'project.changed',
      projectId: opened.projectId,
      projectRevision: 6,
      snapshot
    };

    expect(live.projects[0]!.projectRevision).toBe(1);
    expect(canvasResult.projectRevision).toBe(2);
    expect(textResult.projectRevision).toBe(3);
    expect(documentResult.projectRevision).toBe(4);
    expect(feedbackResult.projectRevision).toBe(5);
    expect(event.projectRevision).toBe(6);
  });
});

function snapshotFixture(): WorkbenchProjectSessionSnapshot {
  return {
    metadata: {
      project: {
        id: 'project-record-id',
        name: 'Test Project',
        createdAt: '2026-06-12T00:00:00.000Z',
        updatedAt: '2026-06-12T00:00:00.000Z'
      }
    },
    files: [],
    canvases: [],
    projections: [],
    diagnostics: [],
    canvasRegistry: { status: 'ready', canvasOrder: [] },
    health: {
      projectName: 'Test Project',
      canvasCount: 0,
      diagnosticCounts: { errors: 0, warnings: 0, infos: 0 },
      runtimeDataLocation: 'debrute-home',
      checkedAt: '2026-06-12T00:00:00.000Z'
    }
  };
}
