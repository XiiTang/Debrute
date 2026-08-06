export type ProjectFileEntryLike = {
  kind: 'file' | 'directory';
  projectRelativePath: string;
  sizeBytes?: number;
  directoryState?: 'unloaded' | 'loaded' | 'error';
  directoryError?: string;
};

export type ProjectFileTreeNode = ProjectFileTreeDirectory | ProjectFileTreeFile;

export interface ProjectFileTreeDirectory {
  kind: 'directory';
  name: string;
  path: string;
  children: ProjectFileTreeNode[];
  directoryState: 'unloaded' | 'loaded' | 'error';
  directoryError?: string;
}

export interface ProjectFileTreeFile {
  kind: 'file';
  name: string;
  path: string;
  sizeBytes?: number;
}

interface MutableDirectory {
  name: string;
  path: string;
  directories: Map<string, MutableDirectory>;
  files: Map<string, ProjectFileTreeFile>;
  directoryState: 'unloaded' | 'loaded' | 'error';
  directoryError?: string;
}

export function buildProjectFileTree(entries: ProjectFileEntryLike[]): ProjectFileTreeNode[] {
  const root: MutableDirectory = {
    name: '',
    path: '',
    directories: new Map(),
    files: new Map(),
    directoryState: 'loaded'
  };

  for (const entry of entries) {
    const normalizedPath = normalizeProjectPath(entry.projectRelativePath);
    if (!normalizedPath || isGitMetadataPath(normalizedPath)) {
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
          files: new Map(),
          directoryState: 'unloaded'
        };
        current.directories.set(part, directory);
      }
      current = directory;
    }

    if (entry.kind === 'directory') {
      current.directoryState = entry.directoryState ?? 'unloaded';
      if (entry.directoryError === undefined) {
        delete current.directoryError;
      } else {
        current.directoryError = entry.directoryError;
      }
    }

    if (entry.kind === 'file') {
      const name = parts[parts.length - 1]!;
      current.files.set(name, {
        kind: 'file',
        name,
        path: normalizedPath,
        ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes })
      });
    }
  }

  return finalizeDirectory(root).children;
}

function isGitMetadataPath(projectRelativePath: string): boolean {
  const firstSegment = projectRelativePath.split('/', 1)[0];
  return firstSegment?.toLowerCase() === '.git';
}

export function expandedProjectTreePaths(tree: ProjectFileTreeNode[], selectedPaths: readonly string[]): Set<string> {
  const expanded = new Set<string>();
  const knownPaths = collectProjectTreePaths(tree);

  for (const selectedPath of selectedPaths) {
    const normalizedPath = normalizeProjectPath(selectedPath);
    if (!knownPaths.has(normalizedPath)) {
      continue;
    }
    let current = parentProjectPath(normalizedPath);
    while (current) {
      expanded.add(current);
      current = parentProjectPath(current);
    }
  }

  return expanded;
}

function collectProjectTreePaths(tree: ProjectFileTreeNode[]): Set<string> {
  const paths = new Set<string>();
  for (const node of tree) {
    collectProjectTreeNodePath(node, paths);
  }
  return paths;
}

function collectProjectTreeNodePath(node: ProjectFileTreeNode, paths: Set<string>): void {
  paths.add(node.path);
  if (node.kind === 'directory') {
    for (const child of node.children) {
      collectProjectTreeNodePath(child, paths);
    }
  }
}

function finalizeDirectory(directory: MutableDirectory): ProjectFileTreeDirectory {
  const directories = [...directory.directories.values()].map(finalizeDirectory);
  const files = [...directory.files.values()];

  return {
    kind: 'directory',
    name: directory.name,
    path: directory.path,
    children: [...directories, ...files],
    directoryState: directory.directoryState,
    ...(directory.directoryError === undefined ? {} : { directoryError: directory.directoryError })
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
