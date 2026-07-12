import React, { act, useEffect, useState } from 'react';
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
  it('owns selection and resets transient Explorer state for a new project', async () => {
    const probe = await renderController();

    await act(async () => {
      probe.current.setSelection(projectTreeSelectionFromPaths(['brief.md']));
      probe.current.beginCreateFile('');
    });
    await act(async () => {
      probe.current.resetForProject('project-2');
    });

    expect(probe.current.selection).toEqual(projectTreeSelectionFromPaths([]));
    expect(probe.current.inlineEdit).toBeUndefined();
    expect(probe.current.fileClipboard).toBeUndefined();
    await probe.unmount();
  });

  it('ignores a file command that settles after Explorer resets for another project', async () => {
    const createResult = deferred<Awaited<ReturnType<WorkbenchApiClient['createProjectFile']>>>();
    const probe = await renderController({
      createProjectFile: vi.fn(() => createResult.promise)
    });

    await act(async () => {
      probe.current.beginCreateFile('');
    });
    await act(async () => {
      probe.current.updateEditValue('old-project.md');
    });
    let submitPromise!: Promise<void>;
    await act(async () => {
      submitPromise = probe.current.submitEdit();
    });
    await act(async () => {
      probe.current.resetForProject('project-2');
    });
    await act(async () => {
      createResult.resolve({
        projectId: 'project-1',
        projectRevision: 2,
        projectRelativePath: 'old-project.md',
        kind: 'file',
        snapshot: snapshotWithFiles(['old-project.md'])
      });
      await submitPromise;
    });

    expect(probe.current.selection).toEqual(projectTreeSelectionFromPaths([]));
    expect(probe.current.inlineEdit).toBeUndefined();
    await probe.unmount();
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
});

function ControllerProbe({ api, onValue }: {
  api: Partial<WorkbenchApiClient>;
  onValue(value: ProjectExplorerController): void;
}): null {
  const [snapshot, setSnapshot] = useState<WorkbenchProjectSessionSnapshot | undefined>(() => snapshotWithFiles([]));
  const controller = useProjectExplorerController({
    api: api as WorkbenchApiClient,
    projectId: 'project-1',
    snapshot,
    commitSnapshot: setSnapshot,
    activeCanvasRuntime: undefined,
    locateProjectFileInCanvas: vi.fn(),
    notify: vi.fn(),
    i18n: createI18n('en')
  });
  useEffect(() => onValue(controller), [controller, onValue]);
  return null;
}

async function renderController(api: Partial<WorkbenchApiClient> = {}): Promise<{
  readonly current: ProjectExplorerController;
  unmount(): Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let current!: ProjectExplorerController;
  const onValue = (value: ProjectExplorerController) => { current = value; };
  await act(async () => root.render(<ControllerProbe api={api} onValue={onValue} />));
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
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
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
      diagnosticCounts: { errors: 0, warnings: 0, infos: 0 },
      runtimeDataLocation: 'project',
      checkedAt: '2026-07-10T00:00:00.000Z'
    }
  };
}
