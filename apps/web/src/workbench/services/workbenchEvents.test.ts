import { describe, expect, it } from 'vitest';
import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import {
  isSnapshotAffectingWorkbenchEvent,
  nextSnapshotFromWorkbenchEvent
} from './workbenchEvents';

describe('workbenchEvents', () => {
  it('uses complete Project events as the only snapshot updates', () => {
    const snapshot = snapshotFixture();
    const event = {
      type: 'project.changed' as const,
      bindingId: 'binding-1',
      projectRevision: 2,
      snapshot
    };
    expect(isSnapshotAffectingWorkbenchEvent(event)).toBe(true);
    expect(nextSnapshotFromWorkbenchEvent(event, undefined)).toBe(snapshot);
    expect(isSnapshotAffectingWorkbenchEvent({
      type: 'product.changed',
      revision: 1,
      product: null
    })).toBe(false);
  });
});

function snapshotFixture(): WorkbenchProjectSessionSnapshot {
  return {
    canonicalRoot: '/projects/example',
    canvasWorkspace: {
      status: 'available',
      workspace: {
        canonicalRoot: '/projects/example',
        expandedDirectories: [],
        nodeStates: {},
        occlusionOrder: []
      },
      canvasResources: { resources: [] },
      feedbackVideoResources: { resources: [] }
    },
    projectTree: [],
    diagnostics: [],
    health: {
      projectName: 'Example',
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-08-05T00:00:00.000Z'
    }
  };
}
