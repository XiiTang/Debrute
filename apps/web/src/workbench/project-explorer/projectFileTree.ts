export type ProjectFileEntryLike = {
  kind: 'file' | 'directory';
  projectRelativePath: string;
};

export type ProjectFileTreeNode = ProjectFileTreeDirectory | ProjectFileTreeFile;

export interface ProjectFileTreeDirectory {
  kind: 'directory';
  name: string;
  path: string;
  children: ProjectFileTreeNode[];
}

export interface ProjectFileTreeFile {
  kind: 'file';
  name: string;
  path: string;
}

interface MutableDirectory {
  name: string;
  path: string;
  directories: Map<string, MutableDirectory>;
  files: Map<string, ProjectFileTreeFile>;
}

export function buildProjectFileTree(entries: ProjectFileEntryLike[]): ProjectFileTreeNode[] {
  const root: MutableDirectory = {
    name: '',
    path: '',
    directories: new Map(),
    files: new Map()
  };

  for (const entry of entries) {
    const normalizedPath = normalizeProjectPath(entry.projectRelativePath);
    if (!normalizedPath || normalizedPath === '.git' || normalizedPath.startsWith('.git/')) {
      continue;
    }

    const parts = normalizedPath.split('/');
    const directoryParts = entry.kind === 'directory' ? parts : parts.slice(0, -1);
    let current = root;

    for (const part of directoryParts) {
      const childPath = joinProjectPath(current.path, part);
      let directory = current.directories.get(part);
      if (!directory) {
        directory = {
          name: part,
          path: childPath,
          directories: new Map(),
          files: new Map()
        };
        current.directories.set(part, directory);
      }
      current = directory;
    }

    if (entry.kind === 'file') {
      const name = parts[parts.length - 1]!;
      current.files.set(name, {
        kind: 'file',
        name,
        path: normalizedPath
      });
    }
  }

  return finalizeDirectory(root).children;
}

export function expandedProjectTreePaths(tree: ProjectFileTreeNode[], selectedPath: string | undefined): Set<string> {
  const expanded = new Set<string>();
  for (const node of tree) {
    if (node.kind === 'directory') {
      expanded.add(node.path);
    }
  }

  let current = selectedPath ? parentProjectPath(normalizeProjectPath(selectedPath)) : undefined;
  while (current) {
    expanded.add(current);
    current = parentProjectPath(current);
  }

  return expanded;
}

function finalizeDirectory(directory: MutableDirectory): ProjectFileTreeDirectory {
  const directories = [...directory.directories.values()]
    .sort(compareByName)
    .map(finalizeDirectory);
  const files = [...directory.files.values()].sort(compareByName);

  return {
    kind: 'directory',
    name: directory.name,
    path: directory.path,
    children: [...directories, ...files]
  };
}

function normalizeProjectPath(path: string): string {
  return path.split('/').filter(Boolean).join('/');
}

function parentProjectPath(path: string): string | undefined {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) {
    return undefined;
  }
  return parts.slice(0, -1).join('/');
}

function joinProjectPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function compareByName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}
