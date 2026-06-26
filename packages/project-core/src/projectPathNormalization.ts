export function normalizeProjectRelativePath(projectRelativePath: string): string {
  return normalizeProjectPath(projectRelativePath, { allowEmpty: false });
}

export function normalizeProjectDirectoryPath(projectRelativePath: string): string {
  return normalizeProjectPath(projectRelativePath, { allowEmpty: true });
}

export function normalizeProjectPath(projectRelativePath: string, options: { allowEmpty: boolean }): string {
  if (projectRelativePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(projectRelativePath)) {
    throw new Error(`Project path must be relative: ${projectRelativePath}`);
  }
  if (projectRelativePath.includes('\\')) {
    throw new Error(`Project path must not contain backslashes: ${projectRelativePath}`);
  }
  if (!projectRelativePath) {
    if (options.allowEmpty) {
      return '';
    }
    throw new Error('Project path must be non-empty.');
  }
  const parts = projectRelativePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Project path must not contain "." or ".." segments: ${projectRelativePath}`);
  }
  return parts.join('/');
}
