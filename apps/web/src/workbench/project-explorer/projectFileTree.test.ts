import { describe, expect, it } from 'vitest';
import { buildProjectFileTree, expandedProjectTreePaths, findProjectFileTreeNode } from './projectFileTree';

describe('project file tree', () => {
  it('builds nested directory and file nodes from project-relative paths', () => {
    const tree = buildProjectFileTree([
      { kind: 'file', projectRelativePath: 'assets/cover.png' },
      { kind: 'file', projectRelativePath: 'assets/pages/page-2.png' },
      { kind: 'directory', projectRelativePath: 'assets/pages' },
      { kind: 'file', projectRelativePath: 'rules/main.md' }
    ]);

    expect(tree).toEqual([
      {
        kind: 'directory',
        name: 'assets',
        path: 'assets',
        children: [
          {
            kind: 'directory',
            name: 'pages',
            path: 'assets/pages',
            children: [
              { kind: 'file', name: 'page-2.png', path: 'assets/pages/page-2.png' }
            ]
          },
          { kind: 'file', name: 'cover.png', path: 'assets/cover.png' }
        ]
      },
      {
        kind: 'directory',
        name: 'rules',
        path: 'rules',
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
      { kind: 'file', projectRelativePath: '.gitignore' },
      { kind: 'file', projectRelativePath: 'assets/cover.png' }
    ]);

    expect(tree).toEqual([
      {
        kind: 'directory',
        name: 'assets',
        path: 'assets',
        children: [
          { kind: 'file', name: 'cover.png', path: 'assets/cover.png' }
        ]
      },
      { kind: 'file', name: '.gitignore', path: '.gitignore' }
    ]);
  });

  it('sorts directories before files and names naturally', () => {
    const tree = buildProjectFileTree([
      { kind: 'file', projectRelativePath: 'page-10.png' },
      { kind: 'file', projectRelativePath: 'page-2.png' },
      { kind: 'directory', projectRelativePath: 'assets-10' },
      { kind: 'directory', projectRelativePath: 'assets-2' }
    ]);

    expect(tree.map((node) => node.name)).toEqual([
      'assets-2',
      'assets-10',
      'page-2.png',
      'page-10.png'
    ]);
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

  it('finds file and directory nodes by project-relative path', () => {
    const tree = buildProjectFileTree([
      { kind: 'file', projectRelativePath: 'assets/pages/page-1.png' },
      { kind: 'file', projectRelativePath: 'briefs/concept.md' }
    ]);

    expect(findProjectFileTreeNode(tree, 'assets')).toMatchObject({ kind: 'directory', path: 'assets' });
    expect(findProjectFileTreeNode(tree, 'assets/pages')).toMatchObject({ kind: 'directory', path: 'assets/pages' });
    expect(findProjectFileTreeNode(tree, 'assets/pages/page-1.png')).toMatchObject({ kind: 'file', path: 'assets/pages/page-1.png' });
    expect(findProjectFileTreeNode(tree, 'missing.md')).toBeUndefined();
  });
});
