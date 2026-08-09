import {
  workbenchCommandShortcutMatches,
  type DebruteProductPlatform
} from '@debrute/app-protocol';

export type ProjectTreeKeyboardCommand =
  | 'copy'
  | 'cut'
  | 'paste'
  | 'delete'
  | 'delete-permanently'
  | 'rename'
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
  platform: DebruteProductPlatform
): ProjectTreeKeyboardCommand | undefined {
  if (isEditableKeyboardTarget(event.target)) {
    return undefined;
  }
  if (event.key === 'Escape') {
    return 'cancel-cut';
  }
  if (event.key === 'F2' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    return 'rename';
  }
  const keyboardEvent = {
    key: event.key,
    ctrlKey: event.ctrlKey === true,
    metaKey: event.metaKey === true,
    altKey: event.altKey === true,
    shiftKey: event.shiftKey === true
  };
  const commands = [
    ['edit.copy', 'copy'],
    ['edit.cut', 'cut'],
    ['edit.paste', 'paste'],
    ['edit.delete', 'delete'],
    ['edit.delete-permanently', 'delete-permanently']
  ] as const;
  const match = commands.find(([commandId]) => (
    workbenchCommandShortcutMatches(commandId, keyboardEvent, platform)
  ));
  if (match) {
    return match[1];
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
