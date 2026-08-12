import type { DebruteProductPlatform } from '@debrute/app-protocol';

export interface RecentProjectPresentation {
  projectRoot: string;
  name: string;
  parentPath: string;
  compactParentPath: string;
}

export function recentProjectPresentation(input: {
  platform: DebruteProductPlatform;
  projectRoot: string;
  userHome: string;
}): RecentProjectPresentation {
  return input.platform === 'win32' || !input.projectRoot.startsWith('/')
    ? windowsProjectPresentation(input.projectRoot)
    : posixProjectPresentation(input.projectRoot, input.userHome);
}

function posixProjectPresentation(
  projectRoot: string,
  userHome: string
): RecentProjectPresentation {
  const displayRoot = trimTrailingSeparators(projectRoot, '/');
  if (displayRoot === '/') {
    return rootPresentation(projectRoot, '/');
  }
  const separatorIndex = displayRoot.lastIndexOf('/');
  const name = displayRoot.slice(separatorIndex + 1) || displayRoot;
  const absoluteParentPath = separatorIndex === 0
    ? '/'
    : displayRoot.slice(0, separatorIndex);
  const parentPath = homeRelativeMacPath(absoluteParentPath, userHome);
  return {
    projectRoot,
    name,
    parentPath,
    compactParentPath: compactPosixParentPath(parentPath)
  };
}

function windowsProjectPresentation(projectRoot: string): RecentProjectPresentation {
  const displayRoot = displayWindowsPath(projectRoot);
  const root = windowsPathRoot(displayRoot);
  const normalizedRoot = trimWindowsTrailingSeparators(displayRoot, root?.rootPath.length ?? 0);
  if (root && (normalizedRoot === root.rootPath || normalizedRoot === root.anchor)) {
    return rootPresentation(projectRoot, normalizedRoot);
  }
  const separatorIndex = normalizedRoot.lastIndexOf('\\');
  const name = normalizedRoot.slice(separatorIndex + 1) || normalizedRoot;
  const parentPath = normalizedRoot.slice(0, separatorIndex);
  return {
    projectRoot,
    name,
    parentPath,
    compactParentPath: compactWindowsParentPath(parentPath)
  };
}

function rootPresentation(projectRoot: string, name: string): RecentProjectPresentation {
  return {
    projectRoot,
    name,
    parentPath: '',
    compactParentPath: ''
  };
}

function homeRelativeMacPath(parentPath: string, userHome: string): string {
  const normalizedHome = trimTrailingSeparators(userHome, '/');
  if (!normalizedHome || normalizedHome === '/') {
    return parentPath;
  }
  if (parentPath === normalizedHome) {
    return '~';
  }
  if (parentPath.startsWith(`${normalizedHome}/`)) {
    return `~${parentPath.slice(normalizedHome.length)}`;
  }
  return parentPath;
}

function compactPosixParentPath(parentPath: string): string {
  if (parentPath === '~' || parentPath === '/') {
    return parentPath;
  }
  const homeRelative = parentPath.startsWith('~/');
  const root = homeRelative ? '~/' : '/';
  const remainder = homeRelative
    ? parentPath.slice(2)
    : parentPath.startsWith('/') ? parentPath.slice(1) : parentPath;
  const segments = remainder.split('/').filter(Boolean);
  if (segments.length <= 1) {
    return parentPath;
  }
  return `${root}…/${segments.at(-1)}`;
}

function displayWindowsPath(projectRoot: string): string {
  const normalized = projectRoot.replaceAll('/', '\\');
  if (normalized.toLocaleLowerCase('en-US').startsWith('\\\\?\\unc\\')) {
    return `\\\\${normalized.slice(8)}`;
  }
  if (normalized.startsWith('\\\\?\\')) {
    return normalized.slice(4);
  }
  return normalized;
}

function compactWindowsParentPath(parentPath: string): string {
  const root = windowsPathRoot(parentPath);
  if (!root) {
    return parentPath;
  }
  const remainder = parentPath.slice(root.rootPath.length).split('\\').filter(Boolean);
  if (remainder.length <= 1) {
    return parentPath;
  }
  return `${root.anchor}…\\${remainder.at(-1)}`;
}

function windowsPathRoot(path: string): { anchor: string; rootPath: string } | undefined {
  const driveRoot = path.match(/^[A-Za-z]:\\/)?.[0];
  if (driveRoot) {
    return { anchor: driveRoot, rootPath: driveRoot };
  }
  const uncRoot = path.match(/^\\\\[^\\]+\\[^\\]+/)?.[0];
  if (uncRoot) {
    return { anchor: `${uncRoot}\\`, rootPath: uncRoot };
  }
  return path.startsWith('\\') ? { anchor: '\\', rootPath: '\\' } : undefined;
}

function trimWindowsTrailingSeparators(path: string, rootPathLength: number): string {
  let end = path.length;
  while (end > rootPathLength && path[end - 1] === '\\') {
    end -= 1;
  }
  return path.slice(0, end);
}

function trimTrailingSeparators(path: string, separator: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === separator) {
    end -= 1;
  }
  return path.slice(0, end);
}
