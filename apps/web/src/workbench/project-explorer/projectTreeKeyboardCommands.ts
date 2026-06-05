export type ProjectTreeKeyboardCommand =
  | 'copy'
  | 'cut'
  | 'paste'
  | 'delete'
  | 'delete-permanently'
  | 'cancel-cut';
export type ProjectTreeFileKeyboardCommand = Exclude<ProjectTreeKeyboardCommand, 'cancel-cut'>;

export interface ProjectTreeKeyboardEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
}

export function projectTreeKeyboardCommandFromEvent(
  event: ProjectTreeKeyboardEventLike,
  platform: NodeJS.Platform
): ProjectTreeKeyboardCommand | undefined {
  if (isEditableKeyboardTarget(event.target)) {
    return undefined;
  }
  if (event.key === 'Escape') {
    return 'cancel-cut';
  }
  const key = event.key.toLowerCase();
  const primaryModifier = platform === 'darwin' ? event.metaKey === true : event.ctrlKey === true;
  if (primaryModifier && !event.altKey && !event.shiftKey && key === 'c') {
    return 'copy';
  }
  if (primaryModifier && !event.altKey && !event.shiftKey && key === 'x') {
    return 'cut';
  }
  if (primaryModifier && !event.altKey && !event.shiftKey && key === 'v') {
    return 'paste';
  }
  if (platform === 'darwin' && event.metaKey === true && event.altKey === true && key === 'backspace') {
    return 'delete-permanently';
  }
  if (
    platform !== 'darwin'
    && event.key === 'Delete'
    && event.shiftKey === true
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
  ) {
    return 'delete-permanently';
  }
  if (event.key === 'Delete' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    return 'delete';
  }
  return undefined;
}

function isEditableKeyboardTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) {
    return false;
  }
  const record = target as { tagName?: unknown; isContentEditable?: unknown };
  if (record.isContentEditable === true) {
    return true;
  }
  if (typeof record.tagName !== 'string') {
    return false;
  }
  const tagName = record.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}
