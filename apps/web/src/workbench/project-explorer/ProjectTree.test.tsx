import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProjectTreeEntry, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { I18nProvider } from '../i18n';
import {
  PROJECT_TREE_ROW_HEIGHT,
  ProjectTree,
  projectExplorerRows,
  projectTreeViewportRange
} from './ProjectTree';
import type { ProjectExplorerViewState } from './useProjectExplorerController';

function renderStaticWithI18n(element: ReactElement): string {
  return renderToStaticMarkup(<I18nProvider locale="en">{element}</I18nProvider>);
}

describe('ProjectTree', () => {
  it('projects the Runtime flat DFS directly and skips collapsed descendants', () => {
    const tree = entries([
      ['', 'directory'],
      ['assets', 'directory'],
      ['assets/pages', 'directory'],
      ['assets/pages/one.png', 'file'],
      ['assets/cover.png', 'file'],
      ['brief.md', 'file']
    ]);

    expect(projectExplorerRows(tree, new Set(['assets']), undefined).map(rowPath)).toEqual([
      'assets',
      'assets/pages',
      'assets/cover.png',
      'brief.md'
    ]);
    expect(projectExplorerRows(tree, new Set(['assets', 'assets/pages']), undefined).map(rowPath)).toEqual([
      'assets',
      'assets/pages',
      'assets/pages/one.png',
      'assets/cover.png',
      'brief.md'
    ]);
  });

  it('derives depth, parent index, and sibling ARIA positions in one flat scan', () => {
    const rows = projectExplorerRows(entries([
      ['', 'directory'],
      ['assets', 'directory'],
      ['assets/a.png', 'file'],
      ['assets/b.png', 'file'],
      ['brief.md', 'file']
    ]), new Set(['assets']), undefined);

    expect(rows).toMatchObject([
      { kind: 'entry', depth: 0, parentIndex: -1, positionInSet: 1, setSize: 2 },
      { kind: 'entry', depth: 1, parentIndex: 0, positionInSet: 1, setSize: 2 },
      { kind: 'entry', depth: 1, parentIndex: 0, positionInSet: 2, setSize: 2 },
      { kind: 'entry', depth: 0, parentIndex: -1, positionInSet: 2, setSize: 2 }
    ]);
  });

  it('places a create row immediately after its expanded parent', () => {
    const edit: ProjectExplorerViewState['edit'] = {
      target: { kind: 'create', entryKind: 'file', parentProjectRelativePath: 'assets' },
      value: 'new.png',
      revision: 3,
      phase: 'editing'
    };
    const rows = projectExplorerRows(entries([
      ['', 'directory'],
      ['assets', 'directory'],
      ['assets/a.png', 'file']
    ]), new Set(['assets']), edit);

    expect(rows.map(rowPath)).toEqual(['assets', '<create:assets>', 'assets/a.png']);
    expect(rows[1]).toMatchObject({ kind: 'create', depth: 1, parentIndex: 0 });
  });

  it('uses one fixed row height and a bounded virtual range', () => {
    expect(PROJECT_TREE_ROW_HEIGHT).toBe(28);
    expect(projectTreeViewportRange({
      scrollTop: 2_800,
      clientHeight: 280,
      rowCount: 1_000,
      overscan: 4
    })).toEqual({ start: 96, end: 114 });
  });

  it('mounts only the initial virtual window for a deeply expanded tree', () => {
    const projectTree: ProjectTreeEntry[] = [{
      projectRelativePath: '',
      kind: 'directory',
      directoryState: 'loaded'
    }];
    const expanded = new Set<string>();
    let path = '';
    for (let index = 0; index < 200; index += 1) {
      path = path ? `${path}/d${index}` : `d${index}`;
      expanded.add(path);
      projectTree.push({ projectRelativePath: path, kind: 'directory', directoryState: 'loaded' });
    }
    const state = viewState({ expanded });
    const html = renderStaticWithI18n(
      <ProjectTree
        generation={9}
        snapshot={{ projectTree } as WorkbenchProjectSessionSnapshot}
        state={state}
        productPlatform="darwin"
        onSelectionChange={() => undefined}
        onToggleDirectory={() => undefined}
        onBeginRename={() => undefined}
        onBeginCreate={() => undefined}
        onEditValueChange={() => undefined}
        onEditSubmit={() => undefined}
        onEditCancel={() => undefined}
        onInternalDrop={() => undefined}
        onExternalDrop={() => undefined}
        onExternalDropError={() => undefined}
      />
    );

    expect((html.match(/data-row-index=/g) ?? []).length).toBeLessThanOrEqual(8);
    expect(html).toContain(`height:${200 * PROJECT_TREE_ROW_HEIGHT}px`);
  });
});

function entries(input: Array<[string, 'file' | 'directory']>): ProjectTreeEntry[] {
  return input.map(([projectRelativePath, kind]) => ({
    projectRelativePath,
    kind,
    ...(kind === 'directory' ? { directoryState: 'loaded' as const } : {})
  }));
}

function rowPath(row: ReturnType<typeof projectExplorerRows>[number]): string {
  return row.kind === 'entry'
    ? row.entry.projectRelativePath
    : `<create:${row.parentProjectRelativePath}>`;
}

function viewState(input: { expanded?: Set<string> } = {}): ProjectExplorerViewState {
  return {
    acceptedProjectRevision: 1,
    selection: { selectedPaths: [], focusedPath: null, anchorPath: null },
    expanded: input.expanded ?? new Set(),
    clipboard: undefined,
    edit: undefined
  };
}
