import type { AdobeBridgeStateView } from '@debrute/app-protocol';
import { describe, expect, it } from 'vitest';
import { availableProjectLinks, linkedProjectTrees } from './projectTreeModel';

describe('linkedProjectTrees', () => {
  it('returns directory-only trees linked to the current Photoshop client', () => {
    expect(linkedProjectTrees(bridgeState(), 'ps-1')).toEqual([{
      projectId: 'project-1',
      projectName: 'Campaign',
      directories: [
        { projectRelativePath: 'assets', name: 'assets', depth: 1 },
        { projectRelativePath: 'assets/refs', name: 'refs', depth: 2 }
      ]
    }]);
  });

  it('returns projects not linked to the current Photoshop client as connectable', () => {
    expect(availableProjectLinks(bridgeState(), 'ps-1')).toEqual([{
      projectId: 'project-2',
      projectName: 'Unlinked'
    }]);
  });
});

function bridgeState(): AdobeBridgeStateView {
  return {
    settings: { enabled: true, discoveryStatus: 'available' },
    adobeClients: [],
    projects: [
      {
        projectId: 'project-1',
        projectName: 'Campaign',
        projectRevision: 1,
        connectedWorkbenchClientCount: 1,
        directories: [
          { projectRelativePath: 'assets', name: 'assets', depth: 1 },
          { projectRelativePath: 'assets/refs', name: 'refs', depth: 2 }
        ]
      },
      {
        projectId: 'project-2',
        projectName: 'Unlinked',
        projectRevision: 1,
        connectedWorkbenchClientCount: 1,
        directories: [{ projectRelativePath: 'out', name: 'out', depth: 1 }]
      }
    ],
    links: [{ linkId: 'link-1', projectId: 'project-1', adobeClientId: 'ps-1', createdAt: '2026-06-18T00:00:00.000Z', status: 'active' }],
    transfers: []
  };
}
