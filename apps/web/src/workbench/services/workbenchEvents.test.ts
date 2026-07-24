import { describe, expect, it } from 'vitest';
import type { WorkbenchEvent, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import {
  isSnapshotAffectingWorkbenchEvent,
  nextSnapshotFromWorkbenchEvent
} from './workbenchEvents';

describe('workbenchEvents', () => {
  it('routes only project snapshot and Canvas document events to snapshot state', () => {
    const snapshot = snapshotFixture();
    const snapshotEventTypes: WorkbenchEvent['type'][] = [
      'project.changed',
      'project.fileChanged',
      'canvas.changed'
    ];
    const nonSnapshotEventTypes: WorkbenchEvent['type'][] = [
      'canvas.feedback.changed',
      'recentProjects.changed',
      'globalSettings.changed',
      'adobeBridge.state.changed'
    ];

    for (const type of snapshotEventTypes) {
      expect(isSnapshotAffectingWorkbenchEvent(workbenchEventForType(type, snapshot))).toBe(true);
    }
    for (const type of nonSnapshotEventTypes) {
      expect(isSnapshotAffectingWorkbenchEvent(workbenchEventForType(type, snapshot))).toBe(false);
    }
  });

  it('replaces the current snapshot from a project snapshot event', () => {
    const current = snapshotFixture();
    const next = snapshotFixture('Next Project');
    const event = workbenchEventForType('project.changed', next);

    if (event.type !== 'project.changed') {
      throw new Error('Expected a project.changed fixture.');
    }
    expect(nextSnapshotFromWorkbenchEvent(event, current)).toBe(next);
  });

  it('does not fabricate a snapshot from a Canvas document event without an open project', () => {
    const event = workbenchEventForType('canvas.changed', snapshotFixture());

    if (event.type !== 'canvas.changed') {
      throw new Error('Expected a canvas.changed fixture.');
    }
    expect(nextSnapshotFromWorkbenchEvent(event, undefined)).toBeUndefined();
  });
});

function workbenchEventForType(
  type: WorkbenchEvent['type'],
  snapshot: WorkbenchProjectSessionSnapshot
): WorkbenchEvent {
  if (type === 'project.changed') {
    return { type, projectId: 'project-live-id', projectRevision: 2, snapshot };
  }
  if (type === 'project.fileChanged') {
    return {
      type,
      projectId: 'project-live-id',
      projectRevision: 2,
      event: { projectRelativePath: 'brief.md', type: 'changed', affects: ['content'] },
      snapshot
    };
  }
  if (type === 'canvas.changed') {
    return {
      type,
      projectId: 'project-live-id',
      projectRevision: 2,
      canvas: {
        id: 'canvas-1',
        name: 'Canvas 1',
        nodeElements: [],
        annotations: [],
        preferences: { showDiagnostics: true }
      },
      projection: { canvasId: 'canvas-1', nodes: [], edges: [], diagnostics: [] }
    };
  }
  return { type } as WorkbenchEvent;
}

function snapshotFixture(projectName = 'Test Project'): WorkbenchProjectSessionSnapshot {
  return {
    metadata: {
      project: {
        id: 'project-record-id',
        name: projectName,
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
      projectName,
      canvasCount: 0,
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-06-12T00:00:00.000Z'
    }
  };
}
