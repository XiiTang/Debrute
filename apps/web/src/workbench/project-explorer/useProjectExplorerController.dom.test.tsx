import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type {
  WorkbenchApiClient,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import type { ProjectCommandGate, ProjectCommandScope } from '../services/projectCommandGate';
import {
  projectExplorerReducer,
  useProjectExplorerController,
  type ProjectExplorerController,
  type ProjectExplorerControllerInput,
  type ProjectExplorerViewState
} from './useProjectExplorerController';

describe('useProjectExplorerController', () => {
  it('submits the raw inline name and waits for the accepted snapshot before selecting it', async () => {
    const accepted = snapshot(['assets', 'assets/  raw/name  '], ['assets']);
    const createProjectFile = vi.fn(async () => ({
      bindingId: 'project-1',
      projectRevision: 2,
      projectRelativePath: 'assets/  raw/name  ',
      kind: 'file' as const
    }));
    const probe = await renderController({
      api: apiFixture({ createProjectFile }),
      waitForRevision: async () => accepted
    });

    await act(async () => {
      probe.current.beginCreate('file', 'assets');
    });
    await act(async () => {
      probe.current.updateEditValue('  raw/name  ');
    });
    await act(async () => {
      await probe.current.submitEdit();
    });

    expect(createProjectFile).toHaveBeenCalledWith({
      parentProjectRelativePath: 'assets',
      name: '  raw/name  '
    });
    expect(probe.current.selection.selectedPaths).toEqual(['assets/  raw/name  ']);
    expect(probe.current.inlineEdit).toBeUndefined();
    await probe.unmount();
  });

  it('deduplicates an in-flight directory load and permits an explicit retry after failure', async () => {
    const first = deferred<{ bindingId: string; projectRevision: number }>();
    const loadProjectDirectory = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ bindingId: 'project-1', projectRevision: 2 });
    const probe = await renderController({
      api: apiFixture({ loadProjectDirectory }),
      snapshot: snapshot(['assets']),
      waitForRevision: async () => snapshot(['assets'], ['assets'])
    });

    let one!: Promise<void>;
    let two!: Promise<void>;
    await act(async () => {
      one = probe.current.ensureDirectoryLoaded('assets');
      two = probe.current.ensureDirectoryLoaded('assets');
      expect(loadProjectDirectory).toHaveBeenCalledOnce();
      first.reject(new Error('unavailable'));
      await expect(one).rejects.toThrow('unavailable');
      await expect(two).rejects.toThrow('unavailable');
    });

    await act(async () => {
      await probe.current.ensureDirectoryLoaded('assets');
    });
    expect(loadProjectDirectory).toHaveBeenCalledTimes(2);
    await probe.unmount();
  });

  it('returns a submitting edit to editable state when the accepted command scope closes', async () => {
    const createProjectFile = vi.fn();
    let submissionCount = 0;
    const probe = await renderController({
      api: apiFixture({ createProjectFile }),
      snapshot: {
        ...snapshot([]),
        projectTree: [{
          projectRelativePath: 'assets',
          kind: 'directory',
          directoryState: 'unloaded'
        }]
      },
      submit: ((operation) => {
        submissionCount += 1;
        return submissionCount === 1 ? operation() : undefined;
      }) as ProjectCommandScope['submit']
    });

    await act(async () => {
      probe.current.beginCreate('file', 'assets');
    });
    await act(async () => {
      probe.current.updateEditValue('new.md');
    });
    await act(async () => {
      await probe.current.submitEdit();
    });

    expect(createProjectFile).not.toHaveBeenCalled();
    expect(probe.current.inlineEdit).toMatchObject({
      phase: 'editing',
      value: 'new.md'
    });
    await probe.unmount();
  });

  it('retries a move conflict exactly once after confirmation', async () => {
    const moved = snapshot(['archive/a.md', 'archive'], ['archive']);
    const moveProjectPaths = vi.fn()
      .mockResolvedValueOnce({
        outcome: 'conflict',
        bindingId: 'project-1',
        projectRevision: 1
      })
      .mockResolvedValueOnce({
        outcome: 'applied',
        bindingId: 'project-1',
        projectRevision: 2,
        results: [{
          status: 'ok',
          sourceProjectRelativePath: 'a.md',
          projectRelativePath: 'archive/a.md',
          kind: 'file'
        }]
      });
    const confirmOverwrite = vi.fn(() => true);
    const probe = await renderController({
      api: apiFixture({ moveProjectPaths }),
      confirmOverwrite,
      waitForRevision: async () => moved
    });

    await act(async () => {
      probe.current.setSelection(selection(['a.md']));
    });
    await act(async () => {
      probe.current.transfer('move', [{ projectRelativePath: 'a.md', kind: 'file' }], 'archive');
      await flushPromises();
    });

    expect(confirmOverwrite).toHaveBeenCalledOnce();
    expect(moveProjectPaths).toHaveBeenNthCalledWith(1, {
      entries: [{ projectRelativePath: 'a.md', kind: 'file' }],
      targetDirectoryProjectRelativePath: 'archive'
    });
    expect(moveProjectPaths).toHaveBeenNthCalledWith(2, {
      entries: [{ projectRelativePath: 'a.md', kind: 'file' }],
      targetDirectoryProjectRelativePath: 'archive',
      overwrite: true
    });
    expect(probe.current.selection.selectedPaths).toEqual(['archive/a.md']);
    await probe.unmount();
  });

  it('accepts partial trash and retains only the failed selected path', async () => {
    const afterTrash = snapshot(['b.md']);
    const trashProjectPaths = vi.fn(async () => ({
      bindingId: 'project-1',
      projectRevision: 2,
      results: [
        {
          status: 'ok' as const,
          sourceProjectRelativePath: 'a.md',
          projectRelativePath: 'a.md',
          kind: 'file' as const
        },
        {
          status: 'failed' as const,
          sourceProjectRelativePath: 'b.md',
          projectRelativePath: 'b.md',
          kind: 'file' as const,
          error: 'busy'
        }
      ]
    }));
    const report = vi.fn();
    const probe = await renderController({
      api: apiFixture({ trashProjectPaths }),
      report,
      waitForRevision: async () => afterTrash
    });

    await act(async () => {
      probe.current.setSelection(selection(['a.md', 'b.md']));
      probe.current.deleteEntries('trash', [
        { projectRelativePath: 'a.md', kind: 'file' },
        { projectRelativePath: 'b.md', kind: 'file' }
      ]);
      await flushPromises();
    });

    expect(probe.current.selection.selectedPaths).toEqual(['b.md']);
    expect(report).toHaveBeenCalledOnce();
    await probe.unmount();
  });

  it('rewrites event-before-response move intent without a second snapshot reconciliation', () => {
    const expanded = new Set(['folder']);
    const before: ProjectExplorerViewState = {
      acceptedProjectRevision: 1,
      selection: selection(['folder/a.md']),
      expanded,
      clipboard: {
        operation: 'cut',
        entries: [{ projectRelativePath: 'folder/a.md', kind: 'file' }]
      },
      edit: undefined
    };
    const accepted = projectExplorerReducer(before, {
      type: 'accept-snapshot',
      snapshot: snapshot(['archive/a.md', 'archive'], ['archive']),
      revision: 2
    });
    expect(accepted.selection.selectedPaths).toEqual([]);

    const settled = projectExplorerReducer(accepted, {
      type: 'settle-transfer',
      snapshot: snapshot(['archive/a.md', 'archive'], ['archive']),
      projectRevision: 2,
      operation: 'move',
      results: [{
        status: 'ok',
        sourceProjectRelativePath: 'folder/a.md',
        projectRelativePath: 'archive/a.md',
        kind: 'file'
      }],
      intent: {
        selection: before.selection,
        expanded: before.expanded,
        clipboard: before.clipboard
      }
    });

    expect(settled.selection.selectedPaths).toEqual(['archive/a.md']);
  });

  it('preserves nested state references for a Canvas-only revision', () => {
    const state: ProjectExplorerViewState = {
      acceptedProjectRevision: 1,
      selection: selection(['a.md']),
      expanded: new Set(['assets']),
      clipboard: {
        operation: 'copy',
        entries: [{ projectRelativePath: 'a.md', kind: 'file' }]
      },
      edit: undefined
    };
    const next = projectExplorerReducer(state, {
      type: 'accept-snapshot',
      snapshot: snapshot(['a.md', 'assets'], ['assets']),
      revision: 2
    });

    expect(next.selection).toBe(state.selection);
    expect(next.expanded).toBe(state.expanded);
    expect(next.clipboard).toBe(state.clipboard);
  });
});

function ControllerProbe({ input, onValue }: {
  input: ProjectExplorerControllerInput;
  onValue(value: ProjectExplorerController): void;
}): null {
  const controller = useProjectExplorerController(input);
  useEffect(() => onValue(controller), [controller, onValue]);
  return null;
}

async function renderController(options: {
  api?: WorkbenchApiClient;
  waitForRevision?: (revision: number) => Promise<WorkbenchProjectSessionSnapshot>;
  confirmOverwrite?: ProjectExplorerControllerInput['confirmOverwrite'];
  report?: (input: Parameters<ProjectExplorerControllerInput['activities']['report']>[0]) => void;
  snapshot?: WorkbenchProjectSessionSnapshot;
  submit?: ProjectCommandScope['submit'];
} = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let current!: ProjectExplorerController;
  const scope: ProjectCommandScope = {
    submit: options.submit ?? ((operation) => operation()),
    isCurrent: (bindingId) => bindingId === undefined || bindingId === 'project-1',
    waitForRevision: options.waitForRevision ?? (async () => snapshot(['a.md', 'b.md', 'assets'], ['assets']))
  };
  const commandGate: ProjectCommandGate = {
    available: () => true,
    accept: () => scope
  };
  const input: ProjectExplorerControllerInput = {
    api: options.api ?? apiFixture(),
    commandGate,
    snapshot: options.snapshot ?? snapshot(['a.md', 'b.md', 'assets'], ['assets']),
    projectRevision: 1,
    activities: { report: options.report ?? vi.fn() },
    confirmOverwrite: options.confirmOverwrite ?? (() => true),
    confirmDelete: () => true,
    onInspectionSelectionChange: () => undefined
  };
  const onValue = (value: ProjectExplorerController) => { current = value; };
  await act(async () => {
    root.render(<ControllerProbe input={input} onValue={onValue} />);
  });
  return {
    get current() { return current; },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    }
  };
}

function apiFixture(overrides: Partial<WorkbenchApiClient> = {}): WorkbenchApiClient {
  return {
    loadProjectDirectory: vi.fn(async () => ({ bindingId: 'project-1', projectRevision: 1 })),
    createProjectFile: vi.fn(),
    createProjectDirectory: vi.fn(),
    renameProjectPath: vi.fn(),
    copyProjectPaths: vi.fn(),
    moveProjectPaths: vi.fn(),
    trashProjectPaths: vi.fn(),
    deleteProjectPathsPermanently: vi.fn(),
    revealProjectPathInSystemFileManager: vi.fn(),
    importExternalLocalProjectPaths: vi.fn(),
    importExternalProjectUploads: vi.fn(),
    ...overrides
  } as unknown as WorkbenchApiClient;
}

function snapshot(
  paths: readonly string[],
  directories: readonly string[] = []
): WorkbenchProjectSessionSnapshot {
  const directorySet = new Set(directories);
  return {
    canonicalRoot: '/projects/project-1',
    canvasWorkspace: {
      status: 'unavailable',
      code: 'canvas_workspace_invalid',
      message: 'test'
    },
    projectTree: paths.map((projectRelativePath) => directorySet.has(projectRelativePath)
      ? { projectRelativePath, kind: 'directory' as const, directoryState: 'loaded' as const }
      : { projectRelativePath, kind: 'file' as const }),
    diagnostics: [],
    health: {
      projectName: 'Test',
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-08-12T00:00:00.000Z'
    }
  };
}

function selection(selectedPaths: readonly string[]) {
  const paths = [...selectedPaths];
  const focusedPath = paths.at(-1) ?? null;
  return { selectedPaths: paths, focusedPath, anchorPath: focusedPath };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
