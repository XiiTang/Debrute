import { describe, expect, it } from 'vitest';
import { buildProjectFileTree, expandedProjectTreePaths } from './projectFileTree';
import {
  createEmptyProjectTreeSelection,
  flattenProjectTree,
  projectTreeDropOperation,
  projectTreeDragEntries,
  projectTreeDropTargetDirectory,
  isProjectTreeMoveNoop,
  isProjectTreeDropRejected,
  projectTreeBatchMoveHasConflict,
  updateProjectTreeContextSelection,
  updateProjectTreeSelection
} from './projectTreeInteraction';

describe('project tree interaction', () => {
  const tree = buildProjectFileTree([
    { kind: 'file', projectRelativePath: 'assets/cover.png' },
    { kind: 'file', projectRelativePath: 'assets/pages/page-1.png' },
    { kind: 'file', projectRelativePath: 'briefs/concept.md' }
  ]);

  it('flattens visible project tree nodes in rendered order', () => {
    expect(flattenProjectTree(tree, new Set(['assets', 'assets/pages'])).map((item) => item.path)).toEqual([
      'assets',
      'assets/pages',
      'assets/pages/page-1.png',
      'assets/cover.png',
      'briefs'
    ]);
  });

  it('expands selected ancestors without auto-expanding unrelated root folders', () => {
    expect([...expandedProjectTreePaths(tree, ['assets/pages/page-1.png'])].sort()).toEqual([
      'assets',
      'assets/pages'
    ]);
  });

  it('plain click creates a single selection with focus and anchor', () => {
    const next = updateProjectTreeSelection({
      state: createEmptyProjectTreeSelection(),
      visibleItems: flattenProjectTree(tree, new Set(['assets', 'briefs'])),
      path: 'briefs/concept.md',
      platform: 'darwin',
      event: {}
    });

    expect(next).toEqual({
      selectedPaths: ['briefs/concept.md'],
      focusedPath: 'briefs/concept.md',
      anchorPath: 'briefs/concept.md'
    });
  });

  it('cmd click toggles one item on macOS', () => {
    const visibleItems = flattenProjectTree(tree, new Set(['assets', 'briefs']));
    const current = {
      selectedPaths: ['assets', 'assets/cover.png'],
      focusedPath: 'assets/cover.png',
      anchorPath: 'assets/cover.png'
    };

    expect(updateProjectTreeSelection({
      state: current,
      visibleItems,
      path: 'briefs',
      platform: 'darwin',
      event: { metaKey: true }
    })).toEqual({
      selectedPaths: ['assets', 'assets/cover.png', 'briefs'],
      focusedPath: 'briefs',
      anchorPath: 'briefs'
    });

    expect(updateProjectTreeSelection({
      state: current,
      visibleItems,
      path: 'assets',
      platform: 'darwin',
      event: { metaKey: true }
    })).toEqual({
      selectedPaths: ['assets/cover.png'],
      focusedPath: 'assets',
      anchorPath: 'assets'
    });
  });

  it('shift click selects the visible range from the anchor', () => {
    const visibleItems = flattenProjectTree(tree, new Set(['assets', 'briefs']));

    expect(updateProjectTreeSelection({
      state: {
        selectedPaths: ['assets'],
        focusedPath: 'assets',
        anchorPath: 'assets'
      },
      visibleItems,
      path: 'briefs/concept.md',
      platform: 'win32',
      event: { shiftKey: true }
    })).toEqual({
      selectedPaths: ['assets', 'assets/pages', 'assets/cover.png', 'briefs', 'briefs/concept.md'],
      focusedPath: 'briefs/concept.md',
      anchorPath: 'assets'
    });
  });

  it('right click preserves an existing multi selection and otherwise selects the clicked item', () => {
    const visibleItems = flattenProjectTree(tree, new Set(['assets', 'briefs']));
    const state = {
      selectedPaths: ['assets/cover.png', 'briefs/concept.md'],
      focusedPath: 'briefs/concept.md',
      anchorPath: 'briefs/concept.md'
    };

    expect(updateProjectTreeContextSelection({
      state,
      visibleItems,
      path: 'assets/cover.png'
    })).toEqual(state);

    expect(updateProjectTreeContextSelection({
      state,
      visibleItems,
      path: 'assets'
    })).toEqual({
      selectedPaths: ['assets'],
      focusedPath: 'assets',
      anchorPath: 'assets'
    });
  });

  it('uses the VS Code internal copy modifier by platform', () => {
    expect(projectTreeDropOperation({ platform: 'darwin', event: { altKey: true } })).toBe('copy');
    expect(projectTreeDropOperation({ platform: 'win32', event: { ctrlKey: true } })).toBe('copy');
    expect(projectTreeDropOperation({ platform: 'darwin', event: { ctrlKey: true } })).toBe('move');
  });

  it('drags the selected set only when the drag starts from a selected item', () => {
    const visibleItems = flattenProjectTree(tree, new Set(['assets', 'briefs']));
    const state = {
      selectedPaths: ['assets/cover.png', 'briefs/concept.md'],
      focusedPath: 'briefs/concept.md',
      anchorPath: 'briefs/concept.md'
    };

    expect(projectTreeDragEntries({ selection: state, visibleItems, path: 'assets/cover.png' })).toEqual([
      { projectRelativePath: 'assets/cover.png', kind: 'file' },
      { projectRelativePath: 'briefs/concept.md', kind: 'file' }
    ]);
    expect(projectTreeDragEntries({ selection: state, visibleItems, path: 'briefs' })).toEqual([
      { projectRelativePath: 'briefs', kind: 'directory' }
    ]);
  });

  it('resolves drop target directories from file, directory, and root targets', () => {
    const visibleItems = flattenProjectTree(tree, new Set(['assets', 'briefs']));

    expect(projectTreeDropTargetDirectory({ visibleItems, path: 'assets' })).toBe('assets');
    expect(projectTreeDropTargetDirectory({ visibleItems, path: 'assets/cover.png' })).toBe('assets');
    expect(projectTreeDropTargetDirectory({ visibleItems, path: undefined })).toBe('');
  });

  it('detects no-op and invalid internal moves', () => {
    expect(isProjectTreeMoveNoop({
      entries: [{ projectRelativePath: 'assets/cover.png', kind: 'file' }],
      targetDirectoryProjectRelativePath: 'assets'
    })).toBe(true);
    expect(isProjectTreeMoveNoop({
      entries: [{ projectRelativePath: 'assets', kind: 'directory' }],
      targetDirectoryProjectRelativePath: 'assets/pages'
    })).toBe(false);
    expect(isProjectTreeMoveNoop({
      entries: [{ projectRelativePath: 'assets/cover.png', kind: 'file' }],
      targetDirectoryProjectRelativePath: 'briefs'
    })).toBe(false);
    expect(isProjectTreeMoveNoop({
      entries: [
        { projectRelativePath: 'assets/cover.png', kind: 'file' },
        { projectRelativePath: 'briefs/concept.md', kind: 'file' }
      ],
      targetDirectoryProjectRelativePath: 'assets'
    })).toBe(false);
  });

  it('rejects dropping directories into themselves or descendants', () => {
    expect(isProjectTreeDropRejected({
      entries: [{ projectRelativePath: 'assets', kind: 'directory' }],
      targetDirectoryProjectRelativePath: 'assets/pages'
    })).toBe(true);
    expect(isProjectTreeDropRejected({
      entries: [{ projectRelativePath: 'assets', kind: 'directory' }],
      targetDirectoryProjectRelativePath: 'assets'
    })).toBe(true);
    expect(isProjectTreeDropRejected({
      entries: [{ projectRelativePath: 'assets/cover.png', kind: 'file' }],
      targetDirectoryProjectRelativePath: 'assets'
    })).toBe(false);
  });

  it('detects batch move conflicts except same-parent no-op targets', () => {
    expect(projectTreeBatchMoveHasConflict({
      existingProjectRelativePaths: new Set(['assets/cover.png']),
      entries: [{ projectRelativePath: 'cover.png', kind: 'file' }],
      targetDirectoryProjectRelativePath: 'assets'
    })).toBe(true);
    expect(projectTreeBatchMoveHasConflict({
      existingProjectRelativePaths: new Set(['assets/cover.png']),
      entries: [{ projectRelativePath: 'assets/cover.png', kind: 'file' }],
      targetDirectoryProjectRelativePath: 'assets'
    })).toBe(false);
  });
});
