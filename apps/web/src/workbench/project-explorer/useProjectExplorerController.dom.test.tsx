import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchApiClient, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { createI18n } from '../i18n';
import { createProjectPathCommandEffects } from '../services/projectPathCommandEffects';
import type {
  AcceptedProjectPathCommandScope
} from '../services/projectPathCommandIntake';
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
      first.current.beginCreateFile(first.scope, '');
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
      probe.current.copyEntries(probe.scope, [{ projectRelativePath: 'brief.md', kind: 'file' }]);
      probe.current.beginRename(probe.scope, { projectRelativePath: 'brief.md', kind: 'file' });
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

  it('pastes exact entries from the controller-owned Copy and Cut clipboard', async () => {
    const copyProjectPaths = vi.fn(async () => ({
      bindingId: 'project-1',
      projectRevision: 2,
      results: []
    }));
    const moveProjectPaths = vi.fn(async () => ({
      bindingId: 'project-1',
      projectRevision: 3,
      results: []
    }));
    const probe = await renderController(
      { copyProjectPaths, moveProjectPaths },
      () => snapshotWithFiles(['brief.md'])
    );
    const entries = [{ projectRelativePath: 'brief.md', kind: 'file' as const }];

    await act(async () => {
      probe.current.copyEntries(probe.scope, entries);
    });
    const copied = probe.current.fileClipboard!;
    await act(async () => {
      probe.current.pasteEntries(probe.scope, {
        clipboard: copied,
        targetDirectoryProjectRelativePath: 'copies'
      });
      await Promise.resolve();
    });
    expect(copyProjectPaths).toHaveBeenCalledWith({
      entries,
      targetDirectoryProjectRelativePath: 'copies'
    });

    await act(async () => {
      probe.current.cutEntries(probe.scope, entries);
    });
    const cut = probe.current.fileClipboard!;
    await act(async () => {
      probe.current.pasteEntries(probe.scope, {
        clipboard: cut,
        targetDirectoryProjectRelativePath: 'archive'
      });
      await Promise.resolve();
    });
    expect(moveProjectPaths).toHaveBeenCalledWith({
      entries,
      targetDirectoryProjectRelativePath: 'archive'
    });
    await probe.unmount();
  });

  it('loads a collapsed parent before creating a child inside it', async () => {
    const loadProjectDirectory = vi.fn(async () => ({
      bindingId: 'project-1',
      projectRevision: 2
    }));
    const probe = await renderController({ loadProjectDirectory });

    await act(async () => {
      probe.current.beginCreateFile(probe.scope, 'assets');
      await Promise.resolve();
    });

    expect(loadProjectDirectory).toHaveBeenCalledOnce();
    expect(loadProjectDirectory).toHaveBeenCalledWith('assets');
    expect(probe.current.inlineEdit).toMatchObject({
      kind: 'creating-file',
      parentProjectRelativePath: 'assets'
    });
    await probe.unmount();
  });

  it('does not submit a child create until its collapsed parent has loaded', async () => {
    const directory = deferred<{ bindingId: string; projectRevision: number }>();
    const createProjectFile = vi.fn(async () => ({
      bindingId: 'project-1',
      projectRevision: 3,
      projectRelativePath: 'assets/new.txt',
      kind: 'file' as const
    }));
    const probe = await renderController({
      loadProjectDirectory: vi.fn(() => directory.promise),
      createProjectFile
    });
    await act(async () => {
      probe.current.beginCreateFile(probe.scope, 'assets');
    });
    await act(async () => {
      probe.current.updateEditValue('new.txt');
    });

    let submission!: Promise<void>;
    await act(async () => {
      submission = probe.current.submitEdit(probe.scope);
      await Promise.resolve();
    });
    expect(createProjectFile).not.toHaveBeenCalled();

    await act(async () => {
      directory.resolve({ bindingId: 'project-1', projectRevision: 2 });
      await submission;
    });
    expect(createProjectFile).toHaveBeenCalledOnce();
    await probe.unmount();
  });

  it('keeps a child create retryable when its parent directory load fails', async () => {
    const failedDirectory = deferred<{ bindingId: string; projectRevision: number }>();
    const loadProjectDirectory = vi.fn()
      .mockImplementationOnce(() => failedDirectory.promise)
      .mockResolvedValueOnce({ bindingId: 'project-1', projectRevision: 2 });
    const createProjectFile = vi.fn(async () => ({
      bindingId: 'project-1',
      projectRevision: 3,
      projectRelativePath: 'assets/new.txt',
      kind: 'file' as const
    }));
    const probe = await renderController({ loadProjectDirectory, createProjectFile });
    await act(async () => {
      probe.current.beginCreateFile(probe.scope, 'assets');
    });
    await act(async () => {
      probe.current.updateEditValue('new.txt');
    });
    await act(async () => {
      const submission = probe.current.submitEdit(probe.scope);
      failedDirectory.reject(new Error('directory unavailable'));
      await submission;
    });

    expect(createProjectFile).not.toHaveBeenCalled();
    expect(probe.current.inlineEdit).toMatchObject({
      value: 'new.txt',
      submitting: false,
      error: 'directory unavailable'
    });

    await act(async () => {
      await probe.current.submitEdit(probe.scope);
    });
    expect(loadProjectDirectory).toHaveBeenCalledTimes(2);
    expect(createProjectFile).toHaveBeenCalledOnce();
    await probe.unmount();
  });

  it('uses the accepted stream snapshot after a delete command outcome', async () => {
    const getSnapshot = vi.fn(() => snapshotWithFiles(['folder']));
    const probe = await renderController({
      trashProjectPaths: vi.fn(async () => ({
        bindingId: 'project-1',
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
      probe.current.trashEntries(probe.scope, [{ projectRelativePath: 'folder/brief.md', kind: 'file' }]);
      await Promise.resolve();
    });

    expect(getSnapshot).toHaveBeenCalled();
    expect(probe.current.selection).toEqual(projectTreeSelectionFromPaths(['folder']));
    await probe.unmount();
  });

  it('removes externally deleted roots from the shared Cut clipboard', async () => {
    let snapshot = snapshotWithFiles(['a.md', 'b.md']);
    const probe = await renderController({}, () => snapshot);
    await act(async () => {
      probe.current.cutEntries(probe.scope, [
        { projectRelativePath: 'a.md', kind: 'file' },
        { projectRelativePath: 'b.md', kind: 'file' }
      ]);
    });

    snapshot = snapshotWithFiles(['b.md']);
    await probe.rerender();

    expect(probe.current.fileClipboard).toEqual({
      operation: 'cut',
      entries: [{ projectRelativePath: 'b.md', kind: 'file' }]
    });
    await probe.unmount();
  });

  it('does not submit an external import when admission closes during asynchronous drop planning', async () => {
    let acceptingCommands = true;
    let releaseDroppedFile!: () => void;
    const importExternalProjectUploads = vi.fn();
    const droppedFile = new File(['brief'], 'brief.md', { type: 'text/markdown' });
    const dataTransfer = {
      files: [droppedFile],
      items: [{
        kind: 'file',
        webkitGetAsEntry: () => ({
          name: 'brief.md',
          isFile: true,
          isDirectory: false,
          file: (accept: (file: File) => void) => {
            releaseDroppedFile = () => accept(droppedFile);
          }
        })
      }]
    } as unknown as DataTransfer;
    const probe = await renderController(
      { importExternalProjectUploads },
      undefined,
      () => acceptingCommands
    );

    await act(async () => {
      probe.current.handleExternalDrop(probe.scope, {
        dataTransfer,
        targetDirectoryProjectRelativePath: 'assets'
      });
      acceptingCommands = false;
      releaseDroppedFile();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(importExternalProjectUploads).not.toHaveBeenCalled();
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
      probe.current.trashEntries(probe.scope, [{ projectRelativePath: 'folder/brief.md', kind: 'file' }]);
    });
    currentScope = false;
    await act(async () => {
      deletion.resolve({
        bindingId: 'project-1',
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
      probe.current.trashEntries(probe.scope, [{ projectRelativePath: 'brief.md', kind: 'file' }]);
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
  canSubmitAcceptedScope,
  isCurrentProjectPathCommandScope,
  notify,
  onValue
}: {
  api: Partial<WorkbenchApiClient>;
  getSnapshot: () => WorkbenchProjectSessionSnapshot | undefined;
  canSubmitAcceptedScope: () => boolean;
  isCurrentProjectPathCommandScope: () => boolean;
  notify: (message: string) => void;
  onValue(value: ProjectExplorerController, scope: AcceptedProjectPathCommandScope): void;
}): null {
  const scope = {
    bindingId: 'project-1',
    generation: 1,
    canSubmit: () => canSubmitAcceptedScope() && isCurrentProjectPathCommandScope(),
    isCurrent: (resultBindingId?: string) => isCurrentProjectPathCommandScope()
      && (resultBindingId === undefined || resultBindingId === 'project-1')
  } as AcceptedProjectPathCommandScope;
  const controller = useProjectExplorerController({
    commandEffects: createProjectPathCommandEffects(api as WorkbenchApiClient),
    getSnapshot,
    canvasRuntime: undefined,
    activities: {
      report: (input) => notify(input.kind)
    },
    i18n: createI18n('en'),
    onInspectionSelectionChange: () => undefined
  });
  useEffect(() => onValue(controller, scope), [controller, onValue, scope]);
  return null;
}

async function renderController(
  api: Partial<WorkbenchApiClient> = {},
  getSnapshot: () => WorkbenchProjectSessionSnapshot | undefined = () => snapshotWithFiles([]),
  canSubmitAcceptedScope: () => boolean = () => true,
  isCurrentProjectPathCommandScope: () => boolean = () => true,
  notify: (message: string) => void = vi.fn()
): Promise<{
  readonly current: ProjectExplorerController;
  readonly scope: AcceptedProjectPathCommandScope;
  rerender(): Promise<void>;
  unmount(): Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let current!: ProjectExplorerController;
  let scope!: AcceptedProjectPathCommandScope;
  const onValue = (
    value: ProjectExplorerController,
    acceptedScope: AcceptedProjectPathCommandScope
  ) => {
    current = value;
    scope = acceptedScope;
  };
  const render = () => root.render(
    <ControllerProbe
      api={api}
      getSnapshot={getSnapshot}
      canSubmitAcceptedScope={canSubmitAcceptedScope}
      isCurrentProjectPathCommandScope={isCurrentProjectPathCommandScope}
      notify={notify}
      onValue={onValue}
    />
  );
  await act(async () => render());
  return {
    get current() { return current; },
    get scope() { return scope; },
    async rerender() {
      await act(async () => render());
    },
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
    canonicalRoot: '/projects/project-1',
    canvasWorkspace: emptyCanvasWorkspace('/projects/project-1'),
    projectTree: paths.map((projectRelativePath) => ({
      projectRelativePath,
      kind: 'file' as const
    })),
    diagnostics: [],
    health: {
      projectName: 'Demo',
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-07-10T00:00:00.000Z'
    }
  };
}

function emptyCanvasWorkspace(canonicalRoot: string): WorkbenchProjectSessionSnapshot['canvasWorkspace'] {
  return {
    status: 'available',
    workspace: {
      canonicalRoot,
      expandedDirectories: [],
      nodeStates: {},
      occlusionOrder: []
    },
    canvasResources: { resources: [] },
    feedbackVideoResources: { resources: [] }
  };
}
