import { describe, expect, it, vi } from 'vitest';
import type { CapturedPng, PhotoshopSelectionSnapshot } from './PhotoshopHost.js';
import {
  PhotoshopPluginRuntime,
  type PhotoshopHostPort,
  type RuntimeConnectionPort
} from './PhotoshopPluginRuntime.js';
import type { PluginMessage, RuntimeMessage } from '@debrute/app-protocol';
import type { RuntimeConnectionState } from './RuntimeConnection.js';

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
    harness.host.capturePngs.mockResolvedValue([
      staged('item-1', 'Hero', new Uint8Array([1]), deletionOrder),
      { itemId: 'item-2', ok: false, message: 'Logo is empty.' }
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
        { itemId: 'item-1', ok: true, fileName: 'Hero.png' },
        { itemId: 'item-2', ok: false, errorCode: 'photoshop_export_failed', message: 'Logo is empty.' }
      ]
    });
    expect(harness.runtime.snapshot().result).toEqual({
      tone: 'error',
      message: 'Sent 1 to Poster / exports; failed 1: Logo is empty.'
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
        ok: false,
        errorCode: 'photoshop_export_failed',
        message: 'Photoshop capture failed.'
      }))
    });
    expect(harness.runtime.snapshot().busy).toBe(false);
  });

  it('accepts only the directory snapshot correlated to the current Project revision', () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    });

    harness.runtime.requestDirectories('project-1');
    const request = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    expect(request.type).toBe('photoshop.projectDirectories.request');
    if (request.type !== 'photoshop.projectDirectories.request') {
      throw new Error('expected directory request');
    }
    harness.runtime.requestDirectories('project-1');
    expect(harness.connection.send).toHaveBeenCalledTimes(1);
    harness.message({
      type: 'photoshop.projectDirectories.snapshot',
      requestId: 'stale-request',
      canonicalRoot: 'project-1',
      revision: 4,
      directories: ['stale']
    });
    harness.message({
      type: 'photoshop.projectDirectories.snapshot',
      requestId: request.requestId,
      canonicalRoot: 'project-2',
      revision: request.revision,
      directories: ['mismatched-project']
    });
    harness.message({
      type: 'photoshop.projectDirectories.snapshot',
      requestId: request.requestId,
      canonicalRoot: request.canonicalRoot,
      revision: request.revision + 1,
      directories: ['mismatched-revision']
    });
    expect(harness.runtime.snapshot().directoryTrees).toEqual([{
      canonicalRoot: 'project-1',
      projectRevision: 4,
      status: 'loading',
      directories: []
    }]);

    harness.message({
      type: 'photoshop.projectDirectories.snapshot',
      requestId: request.requestId,
      canonicalRoot: request.canonicalRoot,
      revision: request.revision,
      directories: ['exports', 'assets']
    });
    expect(harness.runtime.snapshot().directoryTrees).toEqual([{
      canonicalRoot: 'project-1',
      projectRevision: 4,
      status: 'loaded',
      directories: ['', 'assets', 'exports']
    }]);
    harness.message({
      type: 'photoshop.projectDirectories.snapshot',
      requestId: request.requestId,
      canonicalRoot: request.canonicalRoot,
      revision: request.revision,
      directories: ['duplicate-response']
    });
    expect(harness.runtime.snapshot().directoryTrees).toEqual([{
      canonicalRoot: 'project-1',
      projectRevision: 4,
      status: 'loaded',
      directories: ['', 'assets', 'exports']
    }]);
  });

  it('loads two expanded Projects concurrently and correlates reversed responses', () => {
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

    harness.message({
      type: 'photoshop.projectDirectories.snapshot',
      requestId: secondRequest.requestId,
      canonicalRoot: secondRequest.canonicalRoot,
      revision: secondRequest.revision,
      directories: ['folder10', 'folder2']
    });
    harness.message({
      type: 'photoshop.projectDirectories.snapshot',
      requestId: firstRequest.requestId,
      canonicalRoot: firstRequest.canonicalRoot,
      revision: firstRequest.revision,
      directories: ['assets']
    });

    expect(harness.runtime.snapshot()).toMatchObject({
      directoryTrees: [
        {
          canonicalRoot: 'project-1',
          projectRevision: 4,
          status: 'loaded',
          directories: ['', 'assets']
        },
        {
          canonicalRoot: 'project-2',
          projectRevision: 7,
          status: 'loaded',
          directories: ['', 'folder10', 'folder2']
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
      directoryTrees: [{
        canonicalRoot: 'project-1',
        projectRevision: 4,
        status: 'loading',
        directories: []
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
    await expect(pendingSend).rejects.toThrow('Debrute Runtime disconnected.');

    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    });
    const reloadedRequest = latestDirectoryRequest(harness);
    harness.message(directorySnapshot(reloadedRequest, ['assets']));
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
    harness.runtime.requestDirectories('project-1');
    const request = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    if (request.type !== 'photoshop.projectDirectories.request') {
      throw new Error('expected directory request');
    }
    harness.message({
      type: 'photoshop.projectDirectories.snapshot',
      requestId: request.requestId,
      canonicalRoot: request.canonicalRoot,
      revision: request.revision,
      directories: ['exports']
    });

    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 5 }]
    });

    expect(harness.runtime.snapshot().directoryTrees).toEqual([]);
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
    harness.message(directorySnapshot(firstRequest, ['assets']));
    harness.runtime.activateDestination('project-2', '');
    const secondRequest = latestDirectoryRequest(harness);
    harness.message(directorySnapshot(secondRequest, ['exports']));

    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [
        { canonicalRoot: 'project-1', name: 'Poster', revision: 5 },
        { canonicalRoot: 'project-2', name: 'Campaign', revision: 7 }
      ]
    });

    expect(harness.runtime.snapshot().directoryTrees).toEqual([
      {
        canonicalRoot: 'project-2',
        projectRevision: 7,
        status: 'loaded',
        directories: ['', 'exports']
      },
      {
        canonicalRoot: 'project-1',
        projectRevision: 5,
        status: 'loading',
        directories: []
      }
    ]);
    expect(latestDirectoryRequest(harness)).toMatchObject({
      canonicalRoot: 'project-1',
      revision: 5
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
    harness.message({
      type: 'photoshop.projectDirectories.snapshot',
      requestId: request.requestId,
      canonicalRoot: request.canonicalRoot,
      revision: request.revision,
      directories: ['data/shopify', 'assets', 'data', 'data/amazon']
    });

    harness.runtime.activateDestination('project-1', 'data');
    harness.runtime.selectDestination('project-1', 'data/shopify');
    expect(harness.runtime.snapshot()).toMatchObject({
      destination: { canonicalRoot: 'project-1', projectRevision: 4, directory: 'data/shopify' },
      expandedDirectories: [
        { canonicalRoot: 'project-1', directory: '' },
        { canonicalRoot: 'project-1', directory: 'data' }
      ]
    });

    harness.runtime.collapseDestination('project-1', 'data');
    expect(harness.runtime.snapshot()).toMatchObject({
      destination: { canonicalRoot: 'project-1', projectRevision: 4, directory: 'data/shopify' },
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
      directoryTrees: [],
      destination: {
        canonicalRoot: 'project-1',
        projectRevision: 4,
        directory: 'data/shopify'
      }
    });

    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 4 }]
    });
    const request = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    if (request.type !== 'photoshop.projectDirectories.request') {
      throw new Error('expected directory request');
    }
    harness.message({
      type: 'photoshop.projectDirectories.snapshot',
      requestId: request.requestId,
      canonicalRoot: request.canonicalRoot,
      revision: request.revision,
      directories: ['data', 'data/shopify']
    });

    expect(harness.runtime.snapshot()).toMatchObject({
      destination: {
        canonicalRoot: 'project-1',
        projectRevision: 4,
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
    harness.message(directorySnapshot(firstRequest, ['data', 'data/shopify']));
    harness.runtime.activateDestination('project-1', 'data');
    harness.runtime.selectDestination('project-1', 'data/shopify');

    harness.loseSession();
    expect(harness.runtime.snapshot()).toMatchObject({
      projects: [],
      directoryTrees: [],
      expandedDirectories: [
        { canonicalRoot: 'project-1', directory: '' },
        { canonicalRoot: 'project-1', directory: 'data' }
      ],
      destination: { canonicalRoot: 'project-1', directory: 'data/shopify' }
    });

    harness.ready();
    harness.message({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 5 }]
    });
    const refreshedRequest = latestDirectoryRequest(harness);
    harness.message(directorySnapshot(refreshedRequest, ['data', 'exports']));

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
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 5 }]
    });
    const request = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
    if (request.type !== 'photoshop.projectDirectories.request') {
      throw new Error('expected directory request');
    }
    harness.message({
      type: 'photoshop.projectDirectories.snapshot',
      requestId: request.requestId,
      canonicalRoot: request.canonicalRoot,
      revision: request.revision,
      directories: ['data', 'exports']
    });

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
    harness.host.capturePngs.mockResolvedValue([
      staged('item-1', 'Hero', new Uint8Array([1]), deletionOrder)
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
      result: { tone: 'success', message: 'Sent 1 file to Poster.' }
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
  let onMessage: ((message: Exclude<RuntimeMessage, { type: 'photoshop.session.ready' }>) => void) | undefined;
  let hostListener: (() => void) | undefined;
  let scheduled: (() => void) | undefined;
  let connectionGeneration = 0;
  const connection = {
    start: vi.fn(),
    stop: vi.fn(),
    sessionGeneration: vi.fn(() => connectionGeneration),
    send: vi.fn(),
    downloadCommandContent: vi.fn(),
    uploadExportItem: vi.fn(async (_commandId, itemId) => ({ fileName: `${itemId === 'item-1' ? 'Hero' : itemId}.png` }))
  } satisfies RuntimeConnectionPort;
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
      connectionGeneration += 1;
      onState?.({ status: 'ready', runtimeInstanceId: 'runtime-1', pluginSessionId: 'session-1' });
    },
    loseSession: () => {
      connectionGeneration += 1;
      onState?.({ status: 'disconnected' });
    },
    message: (message: Exclude<RuntimeMessage, { type: 'photoshop.session.ready' }>) => onMessage?.(message),
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
  harness.runtime.expandDestination(canonicalRoot, '');
  const request = harness.connection.send.mock.calls.at(-1)?.[0] as PluginMessage;
  if (request.type !== 'photoshop.projectDirectories.request') {
    throw new Error('expected directory request');
  }
  harness.message({
    type: 'photoshop.projectDirectories.snapshot',
    requestId: request.requestId,
    canonicalRoot: request.canonicalRoot,
    revision: request.revision,
    directories: directory.split('/').map((_, index, segments) => (
      segments.slice(0, index + 1).join('/')
    ))
  });
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

function directorySnapshot(
  request: Extract<PluginMessage, { type: 'photoshop.projectDirectories.request' }>,
  directories: string[]
): Exclude<RuntimeMessage, { type: 'photoshop.session.ready' }> {
  return {
    type: 'photoshop.projectDirectories.snapshot',
    requestId: request.requestId,
    canonicalRoot: request.canonicalRoot,
    revision: request.revision,
    directories
  };
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
