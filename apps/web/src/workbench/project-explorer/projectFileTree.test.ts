import { describe, expect, it } from 'vitest';
import { buildProjectFileTree, expandedProjectTreePaths } from './projectFileTree';

describe('project file tree', () => {
  it('builds nested directory and file nodes from project-relative paths', () => {
    const tree = buildProjectFileTree([
      { kind: 'file', projectRelativePath: 'assets/cover.png', sizeBytes: 57_000 },
      { kind: 'file', projectRelativePath: 'assets/pages/page-2.png' },
      { kind: 'directory', projectRelativePath: 'assets/pages' },
      { kind: 'file', projectRelativePath: 'rules/main.md' }
    ]);

    expect(tree).toEqual([
      {
        kind: 'directory',
        name: 'assets',
        path: 'assets',
        directoryState: 'unloaded',
        children: [
          {
            kind: 'directory',
            name: 'pages',
            path: 'assets/pages',
            directoryState: 'unloaded',
            children: [
              { kind: 'file', name: 'page-2.png', path: 'assets/pages/page-2.png' }
            ]
          },
          { kind: 'file', name: 'cover.png', path: 'assets/cover.png', sizeBytes: 57_000 }
        ]
      },
      {
        kind: 'directory',
        name: 'rules',
        path: 'rules',
        directoryState: 'unloaded',
        children: [
          { kind: 'file', name: 'main.md', path: 'rules/main.md' }
        ]
      }
    ]);
  });

  it('excludes git internals before building the tree', () => {
    const tree = buildProjectFileTree([
      { kind: 'file', projectRelativePath: '.git/config' },
      { kind: 'directory', projectRelativePath: '.git/objects' },
      { kind: 'directory', projectRelativePath: '.GIT/objects' },
      { kind: 'file', projectRelativePath: '.GIT/config' },
      { kind: 'file', projectRelativePath: '.gitignore' },
      { kind: 'file', projectRelativePath: 'assets/cover.png' }
    ]);

    expect(tree).toEqual([
      {
        kind: 'directory',
        name: 'assets',
        path: 'assets',
        directoryState: 'unloaded',
        children: [
          { kind: 'file', name: 'cover.png', path: 'assets/cover.png' }
        ]
      },
      { kind: 'file', name: '.gitignore', path: '.gitignore' }
    ]);
  });

  it('preserves Runtime sibling order without a Web comparator', () => {
    const tree = buildProjectFileTree([
      { kind: 'directory', projectRelativePath: 'assets-2' },
      { kind: 'directory', projectRelativePath: 'assets-10' },
      { kind: 'file', projectRelativePath: 'page-2.png' },
      { kind: 'file', projectRelativePath: 'page-10.png' }
    ]);

    expect(tree.map((node) => node.name)).toEqual([
      'assets-2',
      'assets-10',
      'page-2.png',
      'page-10.png'
    ]);
  });

  it('keeps Runtime tie-breaker order unchanged', () => {
    const tree = buildProjectFileTree([
      { kind: 'file', projectRelativePath: 'A.png' },
      { kind: 'file', projectRelativePath: 'a.png' },
      { kind: 'file', projectRelativePath: 'page-2.png' },
      { kind: 'file', projectRelativePath: 'page-02.png' }
    ]);

    expect(tree.map((node) => node.name)).toEqual([
      'A.png',
      'a.png',
      'page-2.png',
      'page-02.png'
    ]);
  });

  it('does not reinterpret Runtime Unicode order', () => {
    const tree = buildProjectFileTree([
      { kind: 'file', projectRelativePath: 'Ος' },
      { kind: 'file', projectRelativePath: 'ΟΣ' }
    ]);
    expect(tree.map((node) => node.name)).toEqual(['Ος', 'ΟΣ']);
  });

  it('expands selected path ancestors', () => {
    const tree = buildProjectFileTree([
      { kind: 'file', projectRelativePath: 'assets/pages/page-1.png' },
      { kind: 'file', projectRelativePath: 'assets/references/ref.png' },
      { kind: 'file', projectRelativePath: 'rules/main.md' }
    ]);

    expect([...expandedProjectTreePaths(tree, ['assets/pages/page-1.png'])].sort()).toEqual([
      'assets',
      'assets/pages'
    ]);
  });

});
