import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchApiClient, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { createI18n } from '../i18n';
import { projectTreeSelectionFromPaths } from './workbenchFileCommands';
import {
  useProjectExplorerController,
  type ProjectExplorerController
} from './useProjectExplorerController';

describe('useProjectExplorerController', () => {
  it('starts each Project-scoped controller with fresh transient Explorer state', async () => {
    const first = await renderController();

    await act(async () => {
      first.current.setSelection(projectTreeSelectionFromPaths(['brief.md']));
      first.current.beginCreateFile('');
    });
    await first.unmount();
    const second = await renderController();

    expect(second.current.selection).toEqual(projectTreeSelectionFromPaths([]));
    expect(second.current.inlineEdit).toBeUndefined();
    expect(second.current.fileClipboard).toBeUndefined();
    await second.unmount();
  });

  it('exposes semantic commands for controller-owned clipboard and inline edit state', async () => {
    const probe = await renderController();

    await act(async () => {
      probe.current.copyEntries([{ projectRelativePath: 'brief.md', kind: 'file' }]);
      probe.current.beginRename({ projectRelativePath: 'brief.md', kind: 'file' });
    });

    expect(probe.current.fileClipboard).toEqual({
      operation: 'copy',
      entries: [{ projectRelativePath: 'brief.md', kind: 'file' }]
    });
    expect(probe.current.inlineEdit).toEqual({
      kind: 'renaming',
      projectRelativePath: 'brief.md',
      value: 'brief.md'
    });
    await probe.unmount();
  });

  it('uses the accepted stream snapshot after a delete command outcome', async () => {
    const getSnapshot = vi.fn(() => snapshotWithFiles(['folder']));
    const probe = await renderController({
      trashProjectPaths: vi.fn(async () => ({
        projectId: 'project-1',
        projectRevision: 2,
        results: [{
          sourceProjectRelativePath: 'folder/brief.md',
          projectRelativePath: 'folder/brief.md',
          kind: 'file' as const,
          status: 'ok' as const
        }]
      }))
    }, getSnapshot);

    await act(async () => {
      probe.current.setSelection(projectTreeSelectionFromPaths(['folder/brief.md']));
      probe.current.trashEntries([{ projectRelativePath: 'folder/brief.md', kind: 'file' }]);
      await Promise.resolve();
    });

    expect(getSnapshot).toHaveBeenCalled();
    expect(probe.current.selection).toEqual(projectTreeSelectionFromPaths(['folder']));
    await probe.unmount();
  });

  it('does not submit a Project Path Command after Project switching begins', async () => {
    const trashProjectPaths = vi.fn();
    const probe = await renderController(
      { trashProjectPaths },
      () => snapshotWithFiles(['brief.md']),
      () => false
    );

    await act(async () => {
      probe.current.trashEntries([{ projectRelativePath: 'brief.md', kind: 'file' }]);
    });

    expect(trashProjectPaths).not.toHaveBeenCalled();
    await probe.unmount();
  });

  it('does not create new Project Path edit or clipboard intent while switching', async () => {
    const probe = await renderController({}, undefined, () => false);

    await act(async () => {
      probe.current.beginCreateFile('briefs');
      probe.current.beginCreateDirectory('briefs');
      probe.current.beginRename({ projectRelativePath: 'brief.md', kind: 'file' });
      probe.current.copyEntries([{ projectRelativePath: 'brief.md', kind: 'file' }]);
      probe.current.cutEntries([{ projectRelativePath: 'brief.md', kind: 'file' }]);
    });

    expect(probe.current.inlineEdit).toBeUndefined();
    expect(probe.current.fileClipboard).toBeUndefined();
    await probe.unmount();
  });

  it('does not submit an existing inline edit after Project switching begins', async () => {
    let acceptingCommands = true;
    const renameProjectPath = vi.fn();
    const probe = await renderController(
      { renameProjectPath },
      undefined,
      () => acceptingCommands
    );

    await act(async () => {
      probe.current.beginRename({ projectRelativePath: 'brief.md', kind: 'file' });
      probe.current.updateEditValue('renamed.md');
    });
    acceptingCommands = false;
    await act(async () => {
      await probe.current.submitEdit();
    });

    expect(renameProjectPath).not.toHaveBeenCalled();
    await probe.unmount();
  });

  it('does not call Project adapters from paste, native path, or drop commands while switching', async () => {
    const copyProjectPaths = vi.fn();
    const copyProjectAbsolutePaths = vi.fn();
    const revealProjectPathInSystemFileManager = vi.fn();
    const probe = await renderController({
      copyProjectPaths,
      copyProjectAbsolutePaths,
      revealProjectPathInSystemFileManager
    }, undefined, () => false);
    const entry = { projectRelativePath: 'brief.md', kind: 'file' as const };

    await act(async () => {
      probe.current.pasteEntries({
        clipboard: { operation: 'copy', entries: [entry] },
        targetDirectoryProjectRelativePath: 'copies'
      });
      await probe.current.copyAbsolutePaths([entry]);
      probe.current.revealEntry(entry);
      probe.current.handleInternalDrop({
        entries: [entry],
        targetDirectoryProjectRelativePath: 'copies',
        operation: 'copy'
      });
    });

    expect(copyProjectPaths).not.toHaveBeenCalled();
    expect(copyProjectAbsolutePaths).not.toHaveBeenCalled();
    expect(revealProjectPathInSystemFileManager).not.toHaveBeenCalled();
    await probe.unmount();
  });

  it('ignores a delete result after the accepted Project generation changes', async () => {
    const deletion = deferred<Awaited<ReturnType<WorkbenchApiClient['trashProjectPaths']>>>();
    let currentScope = true;
    const probe = await renderController(
      { trashProjectPaths: vi.fn(() => deletion.promise) },
      () => snapshotWithFiles(['folder']),
      () => true,
      () => currentScope
    );

    await act(async () => {
      probe.current.setSelection(projectTreeSelectionFromPaths(['folder/brief.md']));
      probe.current.trashEntries([{ projectRelativePath: 'folder/brief.md', kind: 'file' }]);
    });
    currentScope = false;
    await act(async () => {
      deletion.resolve({
        projectId: 'project-1',
        projectRevision: 2,
        results: [{
          sourceProjectRelativePath: 'folder/brief.md',
          projectRelativePath: 'folder/brief.md',
          kind: 'file',
          status: 'ok'
        }]
      });
      await deletion.promise;
      await Promise.resolve();
    });

    expect(probe.current.selection).toEqual(projectTreeSelectionFromPaths(['folder/brief.md']));
    await probe.unmount();
  });

  it('suppresses a command failure after the accepted Project generation changes', async () => {
    const deletion = deferred<Awaited<ReturnType<WorkbenchApiClient['trashProjectPaths']>>>();
    const notify = vi.fn();
    let currentScope = true;
    const probe = await renderController(
      { trashProjectPaths: vi.fn(() => deletion.promise) },
      undefined,
      () => true,
      () => currentScope,
      notify
    );

    await act(async () => {
      probe.current.trashEntries([{ projectRelativePath: 'brief.md', kind: 'file' }]);
    });
    currentScope = false;
    await act(async () => {
      deletion.reject(new Error('old Project failed'));
      await deletion.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(notify).not.toHaveBeenCalled();
    await probe.unmount();
  });
});

function ControllerProbe({
  api,
  getSnapshot,
  canStartProjectPathCommand,
  isCurrentProjectPathCommandScope,
  notify,
  onValue
}: {
  api: Partial<WorkbenchApiClient>;
  getSnapshot: () => WorkbenchProjectSessionSnapshot | undefined;
  canStartProjectPathCommand: () => boolean;
  isCurrentProjectPathCommandScope: () => boolean;
  notify: (message: string) => void;
  onValue(value: ProjectExplorerController): void;
}): null {
  const controller = useProjectExplorerController({
    api: api as WorkbenchApiClient,
    projectId: 'project-1',
    projectGeneration: 1,
    getSnapshot,
    activeCanvasRuntime: undefined,
    locateProjectFileInCanvas: vi.fn(),
    notify,
    i18n: createI18n('en'),
    canStartProjectPathCommand,
    isCurrentProjectPathCommandScope
  });
  useEffect(() => onValue(controller), [controller, onValue]);
  return null;
}

async function renderController(
  api: Partial<WorkbenchApiClient> = {},
  getSnapshot: () => WorkbenchProjectSessionSnapshot | undefined = () => snapshotWithFiles([]),
  canStartProjectPathCommand: () => boolean = () => true,
  isCurrentProjectPathCommandScope: () => boolean = () => true,
  notify: (message: string) => void = vi.fn()
): Promise<{
  readonly current: ProjectExplorerController;
  unmount(): Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let current!: ProjectExplorerController;
  const onValue = (value: ProjectExplorerController) => { current = value; };
  await act(async () => root.render(
    <ControllerProbe
      api={api}
      getSnapshot={getSnapshot}
      canStartProjectPathCommand={canStartProjectPathCommand}
      isCurrentProjectPathCommandScope={isCurrentProjectPathCommandScope}
      notify={notify}
      onValue={onValue}
    />
  ));
  return {
    get current() { return current; },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function snapshotWithFiles(paths: string[]): WorkbenchProjectSessionSnapshot {
  return {
    metadata: {
      project: {
        id: 'project-1',
        name: 'Demo',
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z'
      }
    },
    files: paths.map((projectRelativePath) => ({ projectRelativePath, kind: 'file' as const })),
    canvases: [],
    projections: [],
    diagnostics: [],
    canvasRegistry: { status: 'ready', canvasOrder: [] },
    health: {
      projectName: 'Demo',
      canvasCount: 0,
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-07-10T00:00:00.000Z'
    }
  };
}
