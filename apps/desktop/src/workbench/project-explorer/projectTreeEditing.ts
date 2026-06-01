import type { WorkbenchContextMenuTargetKind } from '../shell/contextMenu';

export type ProjectTreeInlineEditState =
  | {
      kind: 'creating-file' | 'creating-directory';
      parentProjectRelativePath: string;
      value: string;
      submitting?: boolean;
      error?: string;
    }
  | {
      kind: 'renaming';
      projectRelativePath: string;
      value: string;
      submitting?: boolean;
      error?: string;
    };

export function createInlineEditState(
  kind: ProjectTreeInlineEditState['kind'],
  projectRelativePath: string
): ProjectTreeInlineEditState {
  if (kind === 'renaming') {
    return {
      kind,
      projectRelativePath,
      value: basenameFromProjectPath(projectRelativePath)
    };
  }
  return {
    kind,
    parentProjectRelativePath: projectRelativePath,
    value: ''
  };
}

export function validateInlineProjectName(value: string): { ok: true; name: string } | { ok: false; message: string } {
  const name = value.trim();
  if (!name) {
    return { ok: false, message: 'Name is required.' };
  }
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, message: 'Name must not contain path separators.' };
  }
  return { ok: true, name };
}

export function projectTreePasteTargetDirectory(target: {
  kind: WorkbenchContextMenuTargetKind;
  projectRelativePath: string;
}): string {
  return target.kind === 'directory' ? target.projectRelativePath : parentProjectPath(target.projectRelativePath);
}

export function parentProjectPath(projectRelativePath: string): string {
  const parts = projectRelativePath.split('/').filter(Boolean);
  return parts.length <= 1 ? '' : parts.slice(0, -1).join('/');
}

function basenameFromProjectPath(projectRelativePath: string): string {
  const parts = projectRelativePath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? projectRelativePath;
}
