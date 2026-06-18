import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdobeBridgeService, createAdobeBridgeError } from '../apps/daemon/src/adobe-bridge/AdobeBridgeService';

describe('AdobeBridgeService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers Photoshop clients, projects, links, and directory-only project snapshots', () => {
    const service = new AdobeBridgeService({
      now: () => new Date('2026-06-18T00:00:00.000Z')
    });

    service.setSettings({ enabled: true, discoveryStatus: 'available' });
    service.upsertPhotoshopClient({
      adobeClientId: 'ps-1',
      hostApp: 'photoshop',
      hostVersion: '2026',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    });
    service.replaceProjects([{
      projectId: 'project-1',
      projectName: 'Campaign',
      projectRevision: 7,
      connectedWorkbenchClientCount: 2,
      files: [
        { projectRelativePath: 'assets', kind: 'directory' },
        { projectRelativePath: 'assets/cover.png', kind: 'file' },
        { projectRelativePath: 'briefs', kind: 'directory' },
        { projectRelativePath: '.debrute', kind: 'directory' },
        { projectRelativePath: '.debrute/canvases', kind: 'directory' },
        { projectRelativePath: '.git', kind: 'directory' }
      ]
    }]);

    service.linkProjectToPhotoshop('project-1', 'ps-1');
    const state = service.state();

    expect(state.adobeClients[0]?.displayName).toBe('Photoshop 2026 · poster.psd');
    expect(state.projects[0]?.directories.map((entry) => entry.projectRelativePath)).toEqual(['assets', 'briefs']);
    expect(state.links).toMatchObject([{ projectId: 'project-1', adobeClientId: 'ps-1', status: 'active' }]);
  });

  it('scopes project directories and links to the requesting Photoshop client', () => {
    const service = new AdobeBridgeService({
      now: () => new Date('2026-06-18T00:00:00.000Z')
    });

    service.setSettings({ enabled: true, discoveryStatus: 'available' });
    service.upsertPhotoshopClient({
      adobeClientId: 'ps-linked',
      hostApp: 'photoshop',
      hostVersion: '2026',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    });
    service.upsertPhotoshopClient({
      adobeClientId: 'ps-unlinked',
      hostApp: 'photoshop',
      hostVersion: '2026',
      documentCount: 1,
      activeDocumentTitle: 'other.psd'
    });
    service.replaceProjects([
      {
        projectId: 'project-linked',
        projectName: 'Linked',
        projectRevision: 1,
        connectedWorkbenchClientCount: 1,
        files: [{ projectRelativePath: 'assets', kind: 'directory' }]
      },
      {
        projectId: 'project-unlinked',
        projectName: 'Unlinked',
        projectRevision: 1,
        connectedWorkbenchClientCount: 1,
        files: [{ projectRelativePath: 'private', kind: 'directory' }]
      }
    ]);
    service.linkProjectToPhotoshop('project-linked', 'ps-linked');

    const linkedState = service.stateForPhotoshopClient('ps-linked');
    const unlinkedState = service.stateForPhotoshopClient('ps-unlinked');

    expect(linkedState.links).toMatchObject([{ projectId: 'project-linked', adobeClientId: 'ps-linked' }]);
    expect(linkedState.projects).toEqual([
      expect.objectContaining({
        projectId: 'project-linked',
        directories: [expect.objectContaining({ projectRelativePath: 'assets' })]
      }),
      expect.objectContaining({
        projectId: 'project-unlinked',
        directories: []
      })
    ]);
    expect(unlinkedState.links).toEqual([]);
    expect(unlinkedState.projects).toEqual([
      expect.objectContaining({ projectId: 'project-linked', directories: [] }),
      expect.objectContaining({ projectId: 'project-unlinked', directories: [] })
    ]);
  });

  it('rejects transfers when bridge is disabled or unlinked', () => {
    const service = new AdobeBridgeService({
      now: () => new Date('2026-06-18T00:00:00.000Z')
    });

    service.setSettings({ enabled: false, discoveryStatus: 'disabled' });
    expect(() => service.assertTransferAllowed('project-1', 'ps-1')).toThrowError(createAdobeBridgeError('adobe_bridge_disabled').message);

    service.setSettings({ enabled: true, discoveryStatus: 'available' });
    service.upsertPhotoshopClient({
      adobeClientId: 'ps-1',
      hostApp: 'photoshop',
      hostVersion: '2026',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    });
    service.replaceProjects([{
      projectId: 'project-1',
      projectName: 'Campaign',
      projectRevision: 1,
      connectedWorkbenchClientCount: 1,
      files: []
    }]);
    expect(() => service.assertTransferAllowed('project-1', 'ps-1')).toThrowError(createAdobeBridgeError('project_not_linked').message);
  });

  it('disconnects clients and fails transfers when disabled', () => {
    const service = new AdobeBridgeService({
      now: () => new Date('2026-06-18T00:00:00.000Z')
    });

    service.setSettings({ enabled: true, discoveryStatus: 'available' });
    service.upsertPhotoshopClient({
      adobeClientId: 'ps-1',
      hostApp: 'photoshop',
      hostVersion: '2026',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    });
    service.replaceProjects([{
      projectId: 'project-1',
      projectName: 'Campaign',
      projectRevision: 1,
      connectedWorkbenchClientCount: 1,
      files: []
    }]);
    service.linkProjectToPhotoshop('project-1', 'ps-1');
    const transfer = service.createTransfer({
      direction: 'debrute-to-photoshop',
      projectId: 'project-1',
      adobeClientId: 'ps-1',
      projectRelativePath: 'assets/cover.png'
    });

    service.setSettings({ enabled: false, discoveryStatus: 'disabled' });

    expect(service.state().adobeClients).toEqual([]);
    expect(service.state().links).toEqual([]);
    expect(service.state().transfers).toMatchObject([{
      transferId: transfer.transferId,
      status: 'failed',
      errorCode: 'adobe_bridge_disabled'
    }]);
  });

  it('fails unfinished transfers when the bridge transfer timeout elapses', () => {
    vi.useFakeTimers();
    let nowMs = Date.parse('2026-06-18T00:00:00.000Z');
    const service = new AdobeBridgeService({
      now: () => new Date(nowMs),
      transferTimeoutMs: 1000
    });

    service.setSettings({ enabled: true, discoveryStatus: 'available' });
    const transfer = service.createTransfer({
      direction: 'debrute-to-photoshop',
      projectId: 'project-1',
      adobeClientId: 'ps-1',
      projectRelativePath: 'assets/cover.png'
    });
    service.updateTransfer({ transferId: transfer.transferId, status: 'running' });

    nowMs += 1000;
    vi.advanceTimersByTime(1000);

    expect(service.state().transfers).toMatchObject([{
      transferId: transfer.transferId,
      status: 'failed',
      errorCode: 'transfer_timeout'
    }]);
  });

  it('does not revive terminal transfer states from late plugin results', () => {
    const service = new AdobeBridgeService({
      now: () => new Date('2026-06-18T00:00:00.000Z')
    });
    const transfer = service.createTransfer({
      direction: 'debrute-to-photoshop',
      projectId: 'project-1',
      adobeClientId: 'ps-1',
      projectRelativePath: 'assets/cover.png'
    });

    service.updateTransfer({
      transferId: transfer.transferId,
      status: 'failed',
      errorCode: 'transfer_timeout',
      message: 'Timed out'
    });
    service.updateTransfer({ transferId: transfer.transferId, status: 'succeeded' });

    expect(service.state().transfers).toMatchObject([{
      transferId: transfer.transferId,
      status: 'failed',
      errorCode: 'transfer_timeout'
    }]);
  });
});
