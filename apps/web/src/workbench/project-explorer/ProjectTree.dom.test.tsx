import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTreeEntry, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { I18nProvider } from '../i18n';
import { PROJECT_TREE_DRAG_MIME, ProjectTree } from './ProjectTree';
import type { ProjectExplorerViewState } from './useProjectExplorerController';

describe('ProjectTree delegated DOM behavior', () => {
  let container: HTMLDivElement;
  let root: Root;
  let resizeCallback: ResizeObserverCallback;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.debruteShell;
    vi.unstubAllGlobals();
  });

  it('ignores width-only resize and mounts newly visible rows during height growth', async () => {
    await renderTree(root, treeProps({
      snapshot: snapshot(Array.from({ length: 60 }, (_, index) => ({
        projectRelativePath: `file-${index}.md`,
        kind: 'file' as const
      })))
    }));
    const tree = requiredElement(container, '.project-tree');
    let height = 112;
    Object.defineProperty(tree, 'clientHeight', { configurable: true, get: () => height });

    await act(async () => resizeCallback([resizeEntry(tree, height, 300)], {} as ResizeObserver));
    const beforeWidth = mountedRows(container);
    expect(beforeWidth).toBe(8);

    await act(async () => resizeCallback([resizeEntry(tree, height, 520)], {} as ResizeObserver));
    expect(mountedRows(container)).toBe(beforeWidth);

    height = 280;
    await act(async () => resizeCallback([resizeEntry(tree, height, 520)], {} as ResizeObserver));
    expect(mountedRows(container)).toBe(14);
  });

  it('keeps pointer and native context-menu behavior inside an inline edit input', async () => {
    const onSelectionChange = vi.fn();
    const onToggleDirectory = vi.fn();
    const onEditCancel = vi.fn();
    const onOpenContextMenu = vi.fn();
    await renderTree(root, treeProps({
      state: viewState({
        edit: {
          target: { kind: 'rename', entry: { projectRelativePath: 'brief.md', kind: 'file' } },
          value: 'brief.md',
          revision: 1,
          phase: 'editing'
        }
      }),
      onSelectionChange,
      onToggleDirectory,
      onEditCancel,
      onOpenContextMenu
    }));
    const input = requiredElement<HTMLInputElement>(container, '.project-tree-edit-input');
    input.focus();

    await act(async () => {
      input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(context));

    expect(document.activeElement).toBe(input);
    expect(context.defaultPrevented).toBe(false);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onToggleDirectory).not.toHaveBeenCalled();
    expect(onEditCancel).not.toHaveBeenCalled();
    expect(onOpenContextMenu).not.toHaveBeenCalled();
  });

  it('range-selects a directory without toggling its disclosure', async () => {
    const onSelectionChange = vi.fn();
    const onToggleDirectory = vi.fn();
    await renderTree(root, treeProps({
      snapshot: snapshot([
        { projectRelativePath: 'a.md', kind: 'file' },
        { projectRelativePath: 'folder', kind: 'directory', directoryState: 'loaded' }
      ]),
      state: viewState({
        selection: { selectedPaths: ['a.md'], focusedPath: 'a.md', anchorPath: 'a.md' }
      }),
      onSelectionChange,
      onToggleDirectory
    }));
    const directory = requiredElement(container, '[data-row-index="1"]');

    await act(async () => {
      directory.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        shiftKey: true
      }));
    });

    expect(onSelectionChange).toHaveBeenCalledWith({
      selectedPaths: ['a.md', 'folder'],
      focusedPath: 'folder',
      anchorPath: 'a.md'
    });
    expect(onToggleDirectory).not.toHaveBeenCalled();
  });

  it('keeps the edit focused through submit and focuses the tree only after the edit ends', async () => {
    const onEditSubmit = vi.fn();
    const edit = {
      target: { kind: 'rename' as const, entry: { projectRelativePath: 'brief.md', kind: 'file' as const } },
      value: 'brief.md',
      revision: 1,
      phase: 'editing' as const
    };
    const props = treeProps({ state: viewState({ edit }), onEditSubmit });
    await renderTree(root, props);
    const input = requiredElement<HTMLInputElement>(container, '.project-tree-edit-input');
    input.focus();

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter'
      }));
    });

    expect(onEditSubmit).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(input);

    await renderTree(root, {
      ...props,
      state: viewState({ edit: undefined })
    });
    expect(document.activeElement).toBe(requiredElement(container, '.project-tree'));
  });

  it('retains the private drag payload after crossing an invalid target', async () => {
    const onInternalDrop = vi.fn();
    await renderTree(root, treeProps({
      snapshot: snapshot([
        { projectRelativePath: 'folder', kind: 'directory', directoryState: 'loaded' }
      ]),
      state: viewState({
        selection: { selectedPaths: ['folder'], focusedPath: 'folder', anchorPath: 'folder' }
      }),
      onInternalDrop
    }));
    const tree = requiredElement(container, '.project-tree');
    const directory = requiredElement(container, '[data-row-index="0"]');
    const transfer = dataTransfer();

    await act(async () => directory.dispatchEvent(dragEvent('dragstart', transfer)));
    expect(transfer.types).toEqual([PROJECT_TREE_DRAG_MIME]);
    await act(async () => directory.dispatchEvent(dragEvent('dragover', transfer)));
    await act(async () => tree.dispatchEvent(dragEvent('drop', transfer)));

    expect(onInternalDrop).toHaveBeenCalledOnce();
    expect(onInternalDrop).toHaveBeenCalledWith({
      operation: 'move',
      entries: [{ projectRelativePath: 'folder', kind: 'directory' }],
      targetDirectoryProjectRelativePath: ''
    });
  });

  it('drops an asynchronous browser traversal result after generation unmount', async () => {
    const onExternalDrop = vi.fn();
    const onExternalDropError = vi.fn();
    let release!: () => void;
    const file = new File(['x'], 'slow.md', { type: 'text/markdown' });
    const transfer = dataTransfer({
      files: [file],
      items: [{
        kind: 'file',
        webkitGetAsEntry: () => ({
          name: 'slow.md',
          isFile: true,
          isDirectory: false,
          file: (accept: (value: File) => void) => { release = () => accept(file); }
        })
      }]
    });
    await renderTree(root, treeProps({ onExternalDrop, onExternalDropError }));
    const tree = requiredElement(container, '.project-tree');

    await act(async () => tree.dispatchEvent(dragEvent('drop', transfer)));
    await act(async () => root.unmount());
    release();
    await Promise.resolve();
    await Promise.resolve();

    expect(onExternalDrop).not.toHaveBeenCalled();
    expect(onExternalDropError).not.toHaveBeenCalled();
    root = createRoot(container);
  });
});

async function renderTree(root: Root, props: React.ComponentProps<typeof ProjectTree>): Promise<void> {
  await act(async () => {
    root.render(<I18nProvider locale="en"><ProjectTree {...props} /></I18nProvider>);
  });
}

function treeProps(overrides: Partial<React.ComponentProps<typeof ProjectTree>> = {}): React.ComponentProps<typeof ProjectTree> {
  return {
    generation: 1,
    snapshot: snapshot([{ projectRelativePath: 'brief.md', kind: 'file' }]),
    state: viewState(),
    productPlatform: 'darwin',
    onSelectionChange: vi.fn(),
    onToggleDirectory: vi.fn(),
    onBeginRename: vi.fn(),
    onBeginCreate: vi.fn(),
    onEditValueChange: vi.fn(),
    onEditSubmit: vi.fn(),
    onEditCancel: vi.fn(),
    onInternalDrop: vi.fn(),
    onExternalDrop: vi.fn(),
    onExternalDropError: vi.fn(),
    ...overrides
  };
}

function viewState(overrides: Partial<ProjectExplorerViewState> = {}): ProjectExplorerViewState {
  return {
    acceptedProjectRevision: 1,
    selection: { selectedPaths: [], focusedPath: null, anchorPath: null },
    expanded: new Set(),
    clipboard: undefined,
    edit: undefined,
    ...overrides
  };
}

function snapshot(entries: ProjectTreeEntry[]): WorkbenchProjectSessionSnapshot {
  return {
    canonicalRoot: '/projects/test',
    canvasWorkspace: {
      status: 'unavailable',
      code: 'canvas_workspace_invalid',
      message: 'test'
    },
    projectTree: [
      { projectRelativePath: '', kind: 'directory', directoryState: 'loaded' },
      ...entries
    ],
    diagnostics: [],
    health: {
      projectName: 'Test',
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-08-12T00:00:00.000Z'
    }
  };
}

function resizeEntry(target: Element, height: number, width: number): ResizeObserverEntry {
  return {
    target,
    contentRect: { height, width } as DOMRectReadOnly
  } as ResizeObserverEntry;
}

function mountedRows(container: HTMLElement): number {
  return container.querySelectorAll('[data-row-index]').length;
}

function requiredElement<T extends Element = HTMLElement>(container: ParentNode, selector: string): T {
  const value = container.querySelector<T>(selector);
  if (!value) throw new Error(`Missing ${selector}`);
  return value;
}

function dataTransfer(overrides: {
  files?: File[];
  items?: unknown[];
} = {}): DataTransfer & { types: string[] } {
  const types: string[] = [];
  return {
    files: overrides.files ?? [],
    items: overrides.items ?? [],
    types,
    effectAllowed: 'uninitialized',
    setData(type: string) {
      if (!types.includes(type)) types.push(type);
    }
  } as unknown as DataTransfer & { types: string[] };
}

function dragEvent(type: string, transfer: DataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: transfer },
    altKey: { value: false },
    ctrlKey: { value: false }
  });
  return event;
}
