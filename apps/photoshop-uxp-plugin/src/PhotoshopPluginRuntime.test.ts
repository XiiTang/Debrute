import { describe, expect, it, vi } from 'vitest';
import type { CapturedPng, PhotoshopSelectionSnapshot } from './PhotoshopHost.js';
import {
  PhotoshopPluginRuntime,
  type PhotoshopHostPort,
  type RuntimeConnectionPort
} from './PhotoshopPluginRuntime.js';
import type {
  PhotoshopProjectDirectoryPage,
  PluginMessage,
  RuntimeMessage
} from '@debrute/app-protocol';
import {
  RuntimeSessionLostError,
  RuntimeTransferRejectedError,
  RuntimeUploadOutcomeUnknownError,
  type RuntimeConnectionState,
  type RuntimeSessionLease
} from './RuntimeConnection.js';

describe('PhotoshopPluginRuntime', () => {
  it('starts independently of the panel and publishes complete Document snapshots', () => {
    const harness = createHarness();

    harness.runtime.start();
    expect(harness.connection.start).toHaveBeenCalledOnce();
    harness.ready();

    harness.host.documentsValue = [
      { documentId: 7, title: 'A.psd' },
      { documentId: 9, title: 'B.psd' }
    ];
    harness.host.emitChange();
    harness.flushHostChange();

    expect(harness.connection.send).toHaveBeenCalledWith({
      type: 'photoshop.documents.snapshot',
      documents: harness.host.documentsValue
    });
  });

  it('captures the whole selection before serial uploads and reports independent results', async () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    });
    harness.host.selectionValue = {
      documentId: 7,
      documentTitle: 'A.psd',
      items: [
        { layerId: 11, name: 'Hero', kind: 'layer' },
        { layerId: 12, name: 'Logo', kind: 'group' }
      ]
    };
    const deletionOrder: string[] = [];
    harness.host.capturePngs.mockImplementation(async (_documentId, items) => [
      staged(items[0]!.itemId, 'Hero', new Uint8Array([1]), deletionOrder),
      { itemId: items[1]!.itemId, ok: false, message: 'Logo is empty.' }
    ]);

    selectDestination(harness, 'project-1', 'exports');
    const pending = harness.runtime.sendSelection();
    const start = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    expect(harness.runtime.snapshot().selection).toEqual(harness.host.selectionValue);
    expect(start.type).toBe('photoshop.export.start');
    if (start.type !== 'photoshop.export.start') throw new Error('expected export start');
    harness.message({ type: 'photoshop.export.ready', commandId: start.commandId });

    await pending;
    expect(harness.host.capturePngs).toHaveBeenCalledOnce();
    expect(harness.connection.uploadExportItem).toHaveBeenCalledTimes(1);
    expect(deletionOrder).toEqual(['Hero']);
    expect(harness.connection.send).toHaveBeenLastCalledWith({
      type: 'photoshop.export.finish',
      commandId: start.commandId,
      items: [
        { itemId: start.items[0]!.itemId, ok: true, fileName: 'Hero.png' },
        { itemId: start.items[1]!.itemId, ok: false }
      ]
    });
    expect(harness.runtime.snapshot().result).toEqual({
      tone: 'error',
      message: 'Sent 1 item to Poster / exports; 1 failed; 0 not attempted. Logo is empty.'
    });
  });

  it('finishes an admitted export with independent failures when batch capture rejects', async () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    });
    harness.host.selectionValue = {
      documentId: 7,
      documentTitle: 'A.psd',
      items: [
        { layerId: 11, name: 'Hero', kind: 'layer' },
        { layerId: 12, name: 'Logo', kind: 'group' }
      ]
    };
    harness.host.capturePngs.mockRejectedValue(new Error('Photoshop capture failed.'));

    selectDestination(harness, 'project-1', 'exports');
    const pending = harness.runtime.sendSelection();
    const start = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    expect(start.type).toBe('photoshop.export.start');
    if (start.type !== 'photoshop.export.start') throw new Error('expected export start');
    harness.message({ type: 'photoshop.export.ready', commandId: start.commandId });

    await expect(pending).rejects.toThrow('Photoshop capture failed.');
    expect(harness.connection.send).toHaveBeenLastCalledWith({
      type: 'photoshop.export.finish',
      commandId: start.commandId,
      items: start.items.map((item) => ({
        itemId: item.itemId,
        ok: false
      }))
    });
    expect(harness.runtime.snapshot().busy).toBe(false);
  });

  it('never borrows a replacement session after disconnect during slow batch capture and cleans every staged file', async () => {
    const harness = createHarness();
    harness.runtime.start();
    const sessionA = harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    }, sessionA);
    harness.runtime.selectDestination('project-1', '');
    harness.host.selectionValue = {
      documentId: 7,
      documentTitle: 'A.psd',
      items: [
        { layerId: 11, name: 'Hero', kind: 'layer' },
        { layerId: 12, name: 'Logo', kind: 'group' }
      ]
    };
    const capture = deferred<CapturedPng[]>();
    const deletionOrder: string[] = [];
    harness.host.capturePngs.mockReturnValue(capture.promise);

    const pending = harness.runtime.sendSelection();
    const start = latestExportStart(harness);
    harness.message({ type: 'photoshop.export.ready', commandId: start.commandId }, sessionA);
    await vi.waitFor(() => expect(harness.host.capturePngs).toHaveBeenCalledOnce());

    harness.loseSession();
    const sessionB = harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    }, sessionB);
    capture.resolve([
      staged(start.items[0]!.itemId, 'Hero', new Uint8Array([1]), deletionOrder),
      staged(start.items[1]!.itemId, 'Logo', new Uint8Array([2]), deletionOrder)
    ]);
    await pending;

    expect(harness.connection.uploadExportItem).not.toHaveBeenCalled();
    expect(harness.sentBy(sessionA).filter((message) => message.type === 'photoshop.export.finish')).toEqual([]);
    expect(harness.sentBy(sessionB).filter((message) => message.type.startsWith('photoshop.export.'))).toEqual([]);
    expect(deletionOrder).toEqual(['Hero', 'Logo']);
    expect(harness.runtime.snapshot()).toMatchObject({ busy: false, activeExport: null });
  });

  it('stops after one unknown POST outcome, marks later items not attempted, and sends no finish or retry', async () => {
    const harness = createHarness();
    harness.runtime.start();
    const session = harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    }, session);
    harness.runtime.selectDestination('project-1', '');
    harness.host.selectionValue = {
      documentId: 7,
      documentTitle: 'A.psd',
      items: [
        { layerId: 11, name: 'Hero', kind: 'layer' },
        { layerId: 12, name: 'Logo', kind: 'layer' }
      ]
    };
    const deletionOrder: string[] = [];
    harness.host.capturePngs.mockImplementation(async (_documentId, items) => items.map((item) => (
      staged(item.itemId, item.sourceName, new Uint8Array([1]), deletionOrder)
    )));
    harness.connection.uploadExportItem.mockRejectedValueOnce(
      new RuntimeUploadOutcomeUnknownError(new Error('response lost'))
    );

    const pending = harness.runtime.sendSelection();
    const start = latestExportStart(harness);
    harness.message({ type: 'photoshop.export.ready', commandId: start.commandId }, session);
    await pending;

    expect(harness.connection.uploadExportItem).toHaveBeenCalledOnce();
    expect(harness.sentBy(session).filter((message) => message.type === 'photoshop.export.finish')).toEqual([]);
    expect(harness.runtime.snapshot().result).toEqual({
      tone: 'error',
      message: '0 items were confirmed in Poster; 1 item has an unknown outcome and may have been saved; 1 item was not attempted.'
    });
    expect(deletionOrder).toEqual(['Hero', 'Logo']);
  });

  it('continues after an explicit upload rejection and finishes the independently settled batch', async () => {
    const harness = createHarness();
    harness.runtime.start();
    const session = harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    }, session);
    harness.runtime.selectDestination('project-1', '');
    harness.host.selectionValue = {
      documentId: 7,
      documentTitle: 'A.psd',
      items: [
        { layerId: 11, name: 'Hero', kind: 'layer' },
        { layerId: 12, name: 'Logo', kind: 'layer' }
      ]
    };
    const deletionOrder: string[] = [];
    harness.host.capturePngs.mockImplementation(async (_documentId, items) => items.map((item) => (
      staged(item.itemId, item.sourceName, new Uint8Array([1]), deletionOrder)
    )));
    harness.connection.uploadExportItem.mockRejectedValueOnce(
      new RuntimeTransferRejectedError('Runtime rejected Hero.')
    );

    const pending = harness.runtime.sendSelection();
    const start = latestExportStart(harness);
    harness.message({ type: 'photoshop.export.ready', commandId: start.commandId }, session);
    await pending;

    expect(harness.connection.uploadExportItem).toHaveBeenCalledTimes(2);
    expect(harness.sentBy(session).at(-1)).toEqual({
      type: 'photoshop.export.finish',
      commandId: start.commandId,
      items: [
        { itemId: start.items[0]!.itemId, ok: false },
        { itemId: start.items[1]!.itemId, ok: true, fileName: 'Hero.png' }
      ]
    });
    expect(harness.runtime.snapshot().result).toEqual({
      tone: 'error',
      message: 'Sent 1 item to Poster; 1 failed; 0 not attempted. Runtime rejected Hero.'
    });
    expect(deletionOrder).toEqual(['Hero', 'Logo']);
  });

  it('keeps busy through whole-batch cleanup and reports cleanup failure without reversing commit', async () => {
    const harness = createHarness();
    harness.runtime.start();
    const session = harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    }, session);
    harness.runtime.selectDestination('project-1', '');
    harness.host.selectionValue = {
      documentId: 7,
      documentTitle: 'A.psd',
      items: [{ layerId: 11, name: 'Hero', kind: 'layer' }]
    };
    const cleanup = deferred<void>();
    harness.host.capturePngs.mockImplementation(async (_documentId, items) => [{
      itemId: items[0]!.itemId,
      ok: true,
      staged: {
        itemId: items[0]!.itemId,
        layerId: 11,
        sourceName: 'Hero',
        byteLength: 1,
        read: async () => new Uint8Array([1]),
        delete: () => cleanup.promise
      }
    }]);

    const pending = harness.runtime.sendSelection();
    const start = latestExportStart(harness);
    harness.message({ type: 'photoshop.export.ready', commandId: start.commandId }, session);
    await vi.waitFor(() => {
      expect(harness.sentBy(session).some((message) => message.type === 'photoshop.export.finish')).toBe(true);
    });
    expect(harness.runtime.snapshot().busy).toBe(true);
    cleanup.reject(new Error('temp locked'));
    await pending;

    expect(harness.sentBy(session).at(-1)).toEqual({
      type: 'photoshop.export.finish',
      commandId: start.commandId,
      items: [{ itemId: start.items[0]!.itemId, ok: true, fileName: 'Hero.png' }]
    });
    expect(harness.runtime.snapshot()).toMatchObject({
      busy: false,
      result: {
        tone: 'success',
        message: 'Sent 1 item to Poster. Cleanup could not remove 1 Photoshop temporary file.'
      }
    });
  });

  it('accepts only a direct-child result correlated to its lease, request, and base revision', () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    });

    harness.runtime.expandDestination('project-1', '');
    const request = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    expect(request.type).toBe('photoshop.projectDirectories.request');
    if (request.type !== 'photoshop.projectDirectories.request') {
      throw new Error('expected directory request');
    }
    expect(request).toMatchObject({
      canonicalRoot: 'project-1',
      baseProjectRevision: 4,
      directories: ['']
    });
    harness.runtime.requestDirectories('project-1', ['']);
    expect(harness.connection.send).toHaveBeenCalledTimes(1);
    harness.message({
      type: 'photoshop.projectDirectories.result',
      requestId: 'stale-request',
      canonicalRoot: 'project-1',
      baseProjectRevision: 4,
      projectRevision: 5,
      outcome: 'loaded',
      pages: [{ directory: '', outcome: 'loaded', childDirectories: ['stale'] }]
    });
    harness.message({
      type: 'photoshop.projectDirectories.result',
      requestId: request.requestId,
      canonicalRoot: 'project-2',
      baseProjectRevision: request.baseProjectRevision,
      projectRevision: request.baseProjectRevision + 1,
      outcome: 'loaded',
      pages: [{ directory: '', outcome: 'loaded', childDirectories: ['mismatched-project'] }]
    });
    harness.message({
      type: 'photoshop.projectDirectories.result',
      requestId: request.requestId,
      canonicalRoot: request.canonicalRoot,
      baseProjectRevision: request.baseProjectRevision + 1,
      projectRevision: request.baseProjectRevision + 2,
      outcome: 'loaded',
      pages: [{ directory: '', outcome: 'loaded', childDirectories: ['mismatched-revision'] }]
    });
    expect(harness.runtime.snapshot().directoryPages).toEqual([{
      canonicalRoot: 'project-1',
      directory: '',
      projectRevision: 4,
      status: 'loading',
      childDirectories: []
    }]);

    const accepted = directoryResult(request, [
      { directory: '', outcome: 'loaded', childDirectories: ['assets', 'exports'] }
    ]);
    harness.message(accepted);
    expect(harness.runtime.snapshot().directoryPages).toEqual([{
      canonicalRoot: 'project-1',
      projectRevision: 4,
      directory: '',
      status: 'loading',
      childDirectories: []
    }]);
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 5 }]
    });
    expect(harness.runtime.snapshot().directoryPages).toEqual([{
      canonicalRoot: 'project-1',
      projectRevision: 5,
      directory: '',
      status: 'loaded',
      childDirectories: ['assets', 'exports']
    }]);
    harness.message(accepted);
    expect(harness.runtime.snapshot().directoryPages[0]?.childDirectories).toEqual(['assets', 'exports']);
  });

  it('keeps an R to R+1 request pending when the Project snapshot arrives before its result', () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    });
    harness.runtime.expandDestination('project-1', '');
    const request = latestDirectoryRequest(harness);

    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 5 }]
    });
    expect(harness.runtime.snapshot()).toMatchObject({
      projects: [{ canonicalRoot: 'project-1', revision: 5 }],
      directoryPages: [{
        canonicalRoot: 'project-1',
        directory: '',
        projectRevision: 4,
        status: 'loading'
      }]
    });

    harness.message(directoryResult(request, [
      { directory: '', outcome: 'loaded', childDirectories: ['assets'] }
    ]));
    expect(harness.runtime.snapshot().directoryPages).toEqual([{
      canonicalRoot: 'project-1',
      directory: '',
      projectRevision: 5,
      status: 'loaded',
      childDirectories: ['assets']
    }]);
  });

  it('drops an R result after an R+2 Project snapshot and issues a fresh exact-base request', () => {
    const harness = createHarness();
    harness.runtime.start();
    const session = harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    }, session);
    harness.runtime.expandDestination('project-1', '');
    const obsolete = latestDirectoryRequest(harness);

    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 6 }]
    }, session);
    const replacement = latestDirectoryRequest(harness);
    expect(replacement).toMatchObject({
      canonicalRoot: 'project-1',
      baseProjectRevision: 6,
      directories: ['']
    });

    harness.message(directoryResult(obsolete, [
      { directory: '', outcome: 'loaded', childDirectories: ['obsolete'] }
    ]), session);
    expect(harness.runtime.snapshot().directoryPages).toEqual([{
      canonicalRoot: 'project-1',
      directory: '',
      projectRevision: 6,
      status: 'loading',
      childDirectories: []
    }]);

    settleDirectoryRequest(harness, replacement, [
      { directory: '', outcome: 'loaded', childDirectories: ['fresh'] }
    ], 'result-first', session);
    expect(harness.runtime.snapshot().directoryPages[0]).toMatchObject({
      projectRevision: 7,
      status: 'loaded',
      childDirectories: ['fresh']
    });
  });

  it('does not share ProjectTree request or snapshot state across Runtime session leases', () => {
    const harness = createHarness();
    harness.runtime.start();
    const sessionA = harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    }, sessionA);
    harness.runtime.expandDestination('project-1', '');
    const requestA = latestDirectoryRequest(harness);

    harness.loseSession();
    const sessionB = harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    }, sessionB);
    const requestB = latestDirectoryRequest(harness);
    expect(requestB.requestId).not.toBe(requestA.requestId);

    harness.message(directoryResult(requestA, [
      { directory: '', outcome: 'loaded', childDirectories: ['from-a'] }
    ]), sessionA);
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Stale A', revision: 5 }]
    }, sessionA);
    expect(harness.runtime.snapshot()).toMatchObject({
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }],
      directoryPages: [{
        canonicalRoot: 'project-1',
        directory: '',
        projectRevision: 4,
        status: 'loading'
      }]
    });

    settleDirectoryRequest(harness, requestB, [
      { directory: '', outcome: 'loaded', childDirectories: ['from-b'] }
    ], 'result-first', sessionB);
    expect(harness.runtime.snapshot()).toMatchObject({
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 5 }],
      directoryPages: [{
        canonicalRoot: 'project-1',
        projectRevision: 5,
        status: 'loaded',
        childDirectories: ['from-b']
      }]
    });
  });

  it('loads two expanded Projects concurrently and correlates reversed direct-child results', () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [
        { canonicalRoot: 'project-1', name: 'Poster 2', revision: 4 },
        { canonicalRoot: 'project-2', name: 'Poster 10', revision: 7 }
      ]
    });

    harness.runtime.activateDestination('project-1', '');
    const firstRequest = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    harness.runtime.activateDestination('project-2', '');
    const secondRequest = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    if (firstRequest.type !== 'photoshop.projectDirectories.request'
      || secondRequest.type !== 'photoshop.projectDirectories.request') {
      throw new Error('expected directory requests');
    }

    settleDirectoryRequest(harness, secondRequest, [
      { directory: '', outcome: 'loaded', childDirectories: ['folder2', 'folder10'] }
    ]);
    settleDirectoryRequest(harness, firstRequest, [
      { directory: '', outcome: 'loaded', childDirectories: ['assets'] }
    ]);

    expect(harness.runtime.snapshot()).toMatchObject({
      directoryPages: [
        {
          canonicalRoot: 'project-1',
          directory: '',
          projectRevision: 5,
          status: 'loaded',
          childDirectories: ['assets']
        },
        {
          canonicalRoot: 'project-2',
          directory: '',
          projectRevision: 8,
          status: 'loaded',
          childDirectories: ['folder2', 'folder10']
        }
      ],
      expandedDirectories: [
        { canonicalRoot: 'project-1', directory: '' },
        { canonicalRoot: 'project-2', directory: '' }
      ]
    });
  });

  it('loads only on first expansion, reuses the same-revision cache, and can send to the root while loading', async () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    });
    expect(harness.connection.send).not.toHaveBeenCalled();

    harness.runtime.activateDestination('project-1', '');
    const request = latestDirectoryRequest(harness);
    expect(harness.runtime.snapshot()).toMatchObject({
      destination: { canonicalRoot: 'project-1', projectRevision: 4, directory: '' },
      directoryPages: [{
        canonicalRoot: 'project-1',
        directory: '',
        projectRevision: 4,
        status: 'loading',
        childDirectories: []
      }]
    });
    harness.host.selectionValue = {
      documentId: 7,
      documentTitle: 'A.psd',
      items: [{ layerId: 11, name: 'Hero', kind: 'layer' }]
    };
    const pendingSend = harness.runtime.sendSelection();
    expect(harness.connection.send).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'photoshop.export.start',
      canonicalRoot: 'project-1',
      projectRevision: 4,
      directory: ''
    }));
    harness.loseSession();
    await expect(pendingSend).rejects.toThrow('Photoshop Runtime session was lost.');

    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    });
    const reloadedRequest = latestDirectoryRequest(harness);
    settleDirectoryRequest(harness, reloadedRequest, [
      { directory: '', outcome: 'loaded', childDirectories: ['assets'] }
    ]);
    const sendsAfterLoad = harness.connection.send.mock.calls.length;
    harness.runtime.activateDestination('project-1', '');
    harness.runtime.activateDestination('project-1', '');
    expect(harness.connection.send).toHaveBeenCalledTimes(sendsAfterLoad);
    expect(request.canonicalRoot).toBe(reloadedRequest.canonicalRoot);
  });

  it('clears a directory snapshot when its Project or revision is no longer live', () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    });
    harness.runtime.requestDirectories('project-1', ['']);
    const request = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    if (request.type !== 'photoshop.projectDirectories.request') {
      throw new Error('expected directory request');
    }
    settleDirectoryRequest(harness, request, [
      { directory: '', outcome: 'loaded', childDirectories: ['exports'] }
    ]);

    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 6 }]
    });

    expect(harness.runtime.snapshot().directoryPages).toEqual([]);
  });

  it('invalidates and reloads only the expanded Project whose revision changes', () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [
        { canonicalRoot: 'project-1', name: 'Poster', revision: 4 },
        { canonicalRoot: 'project-2', name: 'Campaign', revision: 7 }
      ]
    });
    harness.runtime.activateDestination('project-1', '');
    const firstRequest = latestDirectoryRequest(harness);
    settleDirectoryRequest(harness, firstRequest, [
      { directory: '', outcome: 'loaded', childDirectories: ['assets'] }
    ]);
    harness.runtime.activateDestination('project-2', '');
    const secondRequest = latestDirectoryRequest(harness);
    settleDirectoryRequest(harness, secondRequest, [
      { directory: '', outcome: 'loaded', childDirectories: ['exports'] }
    ]);

    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [
        { canonicalRoot: 'project-1', name: 'Poster', revision: 6 },
        { canonicalRoot: 'project-2', name: 'Campaign', revision: 8 }
      ]
    });

    expect(harness.runtime.snapshot().directoryPages).toEqual([
      {
        canonicalRoot: 'project-1',
        directory: '',
        projectRevision: 6,
        status: 'loading',
        childDirectories: []
      },
      {
        canonicalRoot: 'project-2',
        directory: '',
        projectRevision: 8,
        status: 'loaded',
        childDirectories: ['exports']
      }
    ]);
    expect(latestDirectoryRequest(harness)).toMatchObject({
      canonicalRoot: 'project-1',
      baseProjectRevision: 6,
      directories: ['']
    });
  });

  it('owns exact selection and expansion independently of the panel view', () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [
        { canonicalRoot: 'project-1', name: 'Poster', revision: 4 },
        { canonicalRoot: 'project-2', name: 'Campaign', revision: 7 }
      ]
    });

    harness.runtime.activateDestination('project-1', '');
    expect(harness.runtime.snapshot()).toMatchObject({
      destination: { canonicalRoot: 'project-1', projectRevision: 4, directory: '' },
      expandedDirectories: [{ canonicalRoot: 'project-1', directory: '' }]
    });
    const request = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    if (request.type !== 'photoshop.projectDirectories.request') {
      throw new Error('expected directory request');
    }
    settleDirectoryRequest(harness, request, [
      { directory: '', outcome: 'loaded', childDirectories: ['assets', 'data'] }
    ]);

    harness.runtime.activateDestination('project-1', 'data');
    const dataRequest = latestDirectoryRequest(harness);
    settleDirectoryRequest(harness, dataRequest, [
      { directory: 'data', outcome: 'loaded', childDirectories: ['data/amazon', 'data/shopify'] }
    ]);
    harness.runtime.selectDestination('project-1', 'data/shopify');
    expect(harness.runtime.snapshot()).toMatchObject({
      destination: { canonicalRoot: 'project-1', projectRevision: 6, directory: 'data/shopify' },
      expandedDirectories: [
        { canonicalRoot: 'project-1', directory: '' },
        { canonicalRoot: 'project-1', directory: 'data' }
      ]
    });

    harness.runtime.collapseDestination('project-1', 'data');
    expect(harness.runtime.snapshot()).toMatchObject({
      destination: { canonicalRoot: 'project-1', projectRevision: 6, directory: 'data/shopify' },
      expandedDirectories: [{ canonicalRoot: 'project-1', directory: '' }]
    });
  });

  it('retains a disconnected destination candidate in place until exact revalidation', () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    });
    selectDestination(harness, 'project-1', 'data/shopify');

    harness.loseSession();
    expect(harness.runtime.snapshot()).toMatchObject({
      projects: [],
      directoryPages: [],
      destination: {
        canonicalRoot: 'project-1',
        projectRevision: 6,
        directory: 'data/shopify'
      }
    });

    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 6 }]
    });
    const request = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    if (request.type !== 'photoshop.projectDirectories.request') {
      throw new Error('expected directory request');
    }
    expect(request.directories).toEqual(['', 'data']);
    settleDirectoryRequest(harness, request, [
      { directory: '', outcome: 'loaded', childDirectories: ['data'] },
      { directory: 'data', outcome: 'loaded', childDirectories: ['data/shopify'] }
    ]);

    expect(harness.runtime.snapshot()).toMatchObject({
      destination: {
        canonicalRoot: 'project-1',
        projectRevision: 7,
        directory: 'data/shopify'
      }
    });
  });

  it('retains expansion intent across reconnect and prunes a missing selected directory exactly', () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    });
    harness.runtime.activateDestination('project-1', '');
    const firstRequest = latestDirectoryRequest(harness);
    settleDirectoryRequest(harness, firstRequest, [
      { directory: '', outcome: 'loaded', childDirectories: ['data'] }
    ]);
    harness.runtime.activateDestination('project-1', 'data');
    const dataRequest = latestDirectoryRequest(harness);
    settleDirectoryRequest(harness, dataRequest, [
      { directory: 'data', outcome: 'loaded', childDirectories: ['data/shopify'] }
    ]);
    harness.runtime.selectDestination('project-1', 'data/shopify');

    harness.loseSession();
    expect(harness.runtime.snapshot()).toMatchObject({
      projects: [],
      directoryPages: [],
      expandedDirectories: [
        { canonicalRoot: 'project-1', directory: '' },
        { canonicalRoot: 'project-1', directory: 'data' }
      ],
      destination: { canonicalRoot: 'project-1', directory: 'data/shopify' }
    });

    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 7 }]
    });
    const refreshedRequest = latestDirectoryRequest(harness);
    expect(refreshedRequest.directories).toEqual(['', 'data']);
    settleDirectoryRequest(harness, refreshedRequest, [
      { directory: '', outcome: 'loaded', childDirectories: ['data', 'exports'] },
      { directory: 'data', outcome: 'loaded', childDirectories: [] }
    ]);

    expect(harness.runtime.snapshot()).toMatchObject({
      destination: null,
      expandedDirectories: [
        { canonicalRoot: 'project-1', directory: '' },
        { canonicalRoot: 'project-1', directory: 'data' }
      ]
    });
  });

  it('clears an exact selected directory when the authoritative revision omits it', () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    });
    selectDestination(harness, 'project-1', 'data/shopify');

    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 7 }]
    });
    const request = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    if (request.type !== 'photoshop.projectDirectories.request') {
      throw new Error('expected directory request');
    }
    settleDirectoryRequest(harness, request, [
      { directory: '', outcome: 'loaded', childDirectories: ['data', 'exports'] },
      { directory: 'data', outcome: 'loaded', childDirectories: [] }
    ]);

    expect(harness.runtime.snapshot()).toMatchObject({
      destination: null
    });
  });

  it('keeps an admitted export bound to A while the destination changes to B', async () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [
        { canonicalRoot: 'project-a', name: 'Poster', revision: 4 },
        { canonicalRoot: 'project-b', name: 'Campaign', revision: 7 }
      ]
    });
    harness.runtime.selectDestination('project-a', '');
    harness.host.selectionValue = {
      documentId: 7,
      documentTitle: 'A.psd',
      items: [{ layerId: 11, name: 'Hero', kind: 'layer' }]
    };
    const deletionOrder: string[] = [];
    harness.host.capturePngs.mockImplementation(async (_documentId, items) => [
      staged(items[0]!.itemId, 'Hero', new Uint8Array([1]), deletionOrder)
    ]);

    const pending = harness.runtime.sendSelection();
    const start = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    expect(start).toMatchObject({
      type: 'photoshop.export.start',
      canonicalRoot: 'project-a',
      projectRevision: 4,
      directory: ''
    });
    expect(harness.runtime.snapshot().activeExport).toEqual({
      itemCount: 1,
      destinationLabel: 'Poster'
    });

    harness.runtime.selectDestination('project-b', '');
    expect(harness.runtime.snapshot()).toMatchObject({
      destination: { canonicalRoot: 'project-b', projectRevision: 7, directory: '' },
      activeExport: { itemCount: 1, destinationLabel: 'Poster' }
    });
    if (start.type !== 'photoshop.export.start') throw new Error('expected export start');
    harness.message({ type: 'photoshop.export.ready', commandId: start.commandId });
    await pending;

    expect(harness.runtime.snapshot()).toMatchObject({
      destination: { canonicalRoot: 'project-b', projectRevision: 7, directory: '' },
      activeExport: null,
      result: { tone: 'success', message: 'Sent 1 item to Poster.' }
    });
  });

  it('passes admitted AVIF bytes unchanged into the locked Document before reporting success', async () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    const bytes = new ArrayBuffer(3);
    harness.connection.downloadCommandContent.mockResolvedValue(bytes);
    harness.host.placeEmbeddedSmartObject.mockImplementation(async () => {
      harness.host.selectionValue = {
        documentId: 9,
        documentTitle: 'Target B',
        items: [{ layerId: 77, name: 'Placed AVIF', kind: 'layer' }]
      };
    });

    harness.message({
      type: 'photoshop.place.request',
      commandId: 'command-7',
      documentId: 9,
      fileName: 'hero.avif',
      mimeType: 'image/avif',
      byteLength: 3
    });
    await harness.flushAsync();

    expect(harness.host.placeEmbeddedSmartObject).toHaveBeenCalledWith({
      documentId: 9,
      fileName: 'hero.avif',
      bytes,
      isSessionCurrent: expect.any(Function)
    });
    expect(harness.connection.send).toHaveBeenLastCalledWith({
      type: 'photoshop.place.result',
      commandId: 'command-7',
      ok: true
    });
    expect(harness.runtime.snapshot().selection).toEqual(harness.host.selectionValue);
  });

  it('does not throw a second time when the Runtime disconnects before a place result can be sent', async () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.connection.downloadCommandContent.mockResolvedValue(new ArrayBuffer(3));
    harness.connection.send.mockImplementation((message) => {
      if (message.type === 'photoshop.place.result') throw new Error('socket lost');
    });

    harness.message({
      type: 'photoshop.place.request',
      commandId: 'command-8',
      documentId: 9,
      fileName: 'hero.webp',
      mimeType: 'image/webp',
      byteLength: 3
    });
    await harness.flushAsync();

    expect(harness.runtime.snapshot().busy).toBe(false);
    expect(harness.host.placeEmbeddedSmartObject).toHaveBeenCalledOnce();
  });

  it('does not enter Photoshop after the socket session is lost during download', async () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    let resolveDownload!: (bytes: ArrayBuffer) => void;
    harness.connection.downloadCommandContent.mockImplementation(() => new Promise((resolve) => {
      resolveDownload = resolve;
    }));

    harness.message({
      type: 'photoshop.place.request',
      commandId: 'command-9',
      documentId: 9,
      fileName: 'hero.webp',
      mimeType: 'image/webp',
      byteLength: 3
    });
    await Promise.resolve();
    harness.loseSession();
    resolveDownload(new ArrayBuffer(3));
    await harness.flushAsync();

    expect(harness.host.placeEmbeddedSmartObject).not.toHaveBeenCalled();
    expect(harness.runtime.snapshot().busy).toBe(false);
  });
});

function createHarness() {
  let onState: ((state: RuntimeConnectionState) => void) | undefined;
  let onMessage: ((
    session: RuntimeSessionLease,
    message: Exclude<RuntimeMessage, { type: 'photoshop.session.ready' }>
  ) => void) | undefined;
  let hostListener: (() => void) | undefined;
  let scheduled: (() => void) | undefined;
  let activeSession: RuntimeSessionLease | undefined;
  let sessionSequence = 0;
  const sessionLiveness = new Map<RuntimeSessionLease, boolean>();
  const sessionMessages: Array<{ session: RuntimeSessionLease; message: PluginMessage }> = [];
  const send = vi.fn<RuntimeSessionLease['send']>();
  const downloadCommandContent = vi.fn<RuntimeSessionLease['downloadCommandContent']>();
  const uploadExportItem = vi.fn<RuntimeSessionLease['uploadExportItem']>(
    async () => ({ fileName: 'Hero.png' })
  );
  const connection = {
    start: vi.fn(),
    stop: vi.fn(),
    requireSession: vi.fn(() => {
      if (!activeSession || !sessionLiveness.get(activeSession)) {
        throw new RuntimeSessionLostError();
      }
      return activeSession;
    }),
    send,
    downloadCommandContent,
    uploadExportItem
  };
  const createSession = (pluginSessionId: string): RuntimeSessionLease => {
    let session: RuntimeSessionLease;
    session = {
      pluginSessionId,
      isLive: () => sessionLiveness.get(session) === true,
      send(message) {
        if (!sessionLiveness.get(session)) throw new RuntimeSessionLostError();
        sessionMessages.push({ session, message });
        send(message);
      },
      downloadCommandContent(commandId, expectedBytes) {
        if (!sessionLiveness.get(session)) return Promise.reject(new RuntimeSessionLostError());
        return downloadCommandContent(commandId, expectedBytes);
      },
      uploadExportItem(commandId, itemId, bytes) {
        if (!sessionLiveness.get(session)) return Promise.reject(new RuntimeSessionLostError());
        return uploadExportItem(commandId, itemId, bytes);
      }
    };
    sessionLiveness.set(session, true);
    return session;
  };
  const capturePngs = vi.fn<PhotoshopHostPort['capturePngs']>();
  const placeEmbeddedSmartObject = vi.fn<PhotoshopHostPort['placeEmbeddedSmartObject']>(async () => undefined);
  interface HarnessHost extends PhotoshopHostPort {
    documentsValue: Array<{ documentId: number; title: string }>;
    selectionValue: PhotoshopSelectionSnapshot;
    emitChange(): void;
    capturePngs: typeof capturePngs;
    placeEmbeddedSmartObject: typeof placeEmbeddedSmartObject;
  }
  const host: HarnessHost = {
    hostVersion: () => '27.0',
    placementMimeTypes: () => [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/vnd.adobe.photoshop',
      'image/avif'
    ],
    documentsValue: [{ documentId: 7, title: 'A.psd' }],
    documents() { return this.documentsValue; },
    selectionValue: { documentId: 7, documentTitle: 'A.psd', items: [] },
    selection() { return this.selectionValue; },
    observeChanges(listener) { hostListener = listener; return () => undefined; },
    emitChange() { hostListener?.(); },
    capturePngs,
    placeEmbeddedSmartObject
  };
  const runtime = new PhotoshopPluginRuntime({
    host,
    createConnection(callbacks) {
      onState = callbacks.onState;
      onMessage = callbacks.onMessage;
      return connection;
    },
    schedule(callback) { scheduled = callback; return 1; },
    cancelSchedule() { scheduled = undefined; }
  });
  return {
    runtime,
    host,
    connection,
    ready: () => {
      if (activeSession) sessionLiveness.set(activeSession, false);
      sessionSequence += 1;
      activeSession = createSession(`session-${sessionSequence}`);
      onState?.({
        status: 'ready',
        runtimeInstanceId: 'runtime-1',
        pluginSessionId: activeSession.pluginSessionId
      });
      return activeSession;
    },
    loseSession: () => {
      if (activeSession) sessionLiveness.set(activeSession, false);
      onState?.({ status: 'disconnected' });
    },
    session: () => {
      if (!activeSession) throw new Error('expected a Runtime session');
      return activeSession;
    },
    sentBy: (session: RuntimeSessionLease) => sessionMessages
      .filter((entry) => entry.session === session)
      .map((entry) => entry.message),
    message: (
      message: Exclude<RuntimeMessage, { type: 'photoshop.session.ready' }>,
      session: RuntimeSessionLease | undefined = activeSession
    ) => {
      if (!session) throw new Error('expected a Runtime session');
      onMessage?.(session, message);
    },
    flushHostChange: () => { const callback = scheduled; scheduled = undefined; callback?.(); },
    flushAsync: async () => { await Promise.resolve(); await Promise.resolve(); }
  };
}

function selectDestination(
  harness: ReturnType<typeof createHarness>,
  canonicalRoot: string,
  directory: string
): void {
  if (directory === '') {
    harness.runtime.selectDestination(canonicalRoot, '');
    return;
  }
  const segments = directory.split('/');
  let parent = '';
  for (let index = 0; index < segments.length; index += 1) {
    harness.runtime.expandDestination(canonicalRoot, parent);
    const request = latestDirectoryRequest(harness);
    const child = segments.slice(0, index + 1).join('/');
    settleDirectoryRequest(harness, request, [{
      directory: parent,
      outcome: 'loaded',
      childDirectories: [child]
    }]);
    parent = child;
  }
  harness.runtime.selectDestination(canonicalRoot, directory);
}

function latestDirectoryRequest(
  harness: ReturnType<typeof createHarness>
): Extract<PluginMessage, { type: 'photoshop.projectDirectories.request' }> {
  const request = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
  if (request.type !== 'photoshop.projectDirectories.request') {
    throw new Error('expected directory request');
  }
  return request;
}

function directoryResult(
  request: Extract<PluginMessage, { type: 'photoshop.projectDirectories.request' }>,
  pages: PhotoshopProjectDirectoryPage[],
  projectRevision = request.baseProjectRevision + 1
): Extract<RuntimeMessage, { type: 'photoshop.projectDirectories.result' }> {
  return {
    type: 'photoshop.projectDirectories.result',
    requestId: request.requestId,
    canonicalRoot: request.canonicalRoot,
    baseProjectRevision: request.baseProjectRevision,
    projectRevision,
    outcome: 'loaded',
    pages
  };
}

function settleDirectoryRequest(
  harness: ReturnType<typeof createHarness>,
  request: Extract<PluginMessage, { type: 'photoshop.projectDirectories.request' }>,
  pages: Parameters<typeof directoryResult>[1],
  order: 'result-first' | 'snapshot-first' = 'result-first',
  session: RuntimeSessionLease = harness.session()
): void {
  const result = directoryResult(request, pages);
  const projects = harness.runtime.snapshot().projects.map((project) => project.canonicalRoot === request.canonicalRoot
    ? { ...project, revision: result.projectRevision }
    : project);
  const publishProjects = () => harness.message({ type: 'photoshop.projects.snapshot', projects }, session);
  if (order === 'snapshot-first') {
    publishProjects();
    harness.message(result, session);
  } else {
    harness.message(result, session);
    publishProjects();
  }
}

function latestExportStart(
  harness: ReturnType<typeof createHarness>
): Extract<PluginMessage, { type: 'photoshop.export.start' }> {
  const message = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
  if (message.type !== 'photoshop.export.start') throw new Error('expected export start');
  return message;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function staged(
  itemId: string,
  sourceName: string,
  bytes: Uint8Array,
  deletionOrder: string[]
): CapturedPng {
  return {
    itemId,
    ok: true,
    staged: {
      itemId,
      layerId: 1,
      sourceName,
      byteLength: bytes.byteLength,
      read: async () => bytes,
      delete: async () => { deletionOrder.push(sourceName); }
    }
  };
}
