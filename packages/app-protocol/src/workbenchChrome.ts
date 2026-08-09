import type { DebruteProductPlatform } from './productPlatform.js';

export type NativeMenuCommand =
  | {
      commandId:
        | 'window.new'
        | 'project.open-picker'
        | 'window.close'
        | 'edit.undo'
        | 'edit.redo'
        | 'edit.cut'
        | 'edit.copy'
        | 'edit.paste'
        | 'edit.paste-and-match-style'
        | 'edit.delete'
        | 'edit.select-all'
        | 'view.reload'
        | 'view.toggle-devtools';
    }
  | {
      commandId: 'project.open-path';
      projectRoot: string;
    };

export type NativeMenuCommandId = NativeMenuCommand['commandId'];
type WorkbenchShortcutCommandId = NativeMenuCommandId | 'edit.delete-permanently';

export type NativeEditCommandId = Extract<NativeMenuCommandId,
  | 'edit.cut'
  | 'edit.copy'
  | 'edit.paste'
  | 'edit.delete'
  | 'edit.select-all'
>;

type WorkbenchShortcutKey = 'a' | 'c' | 'i' | 'n' | 'o' | 'r' | 'v' | 'w' | 'x' | 'y' | 'z' | 'Backspace' | 'Delete';

interface WorkbenchCommandShortcut {
  key: WorkbenchShortcutKey;
  primary?: true;
  shift?: true;
  alt?: true;
}

type WorkbenchShortcutKeyboardEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

export function workbenchCommandShortcutMatches(
  commandId: WorkbenchShortcutCommandId,
  event: WorkbenchShortcutKeyboardEvent,
  platform: DebruteProductPlatform
): boolean {
  const shortcut = workbenchCommandShortcut(commandId, platform);
  if (!shortcut) {
    return false;
  }
  return event.key.toLowerCase() === shortcut.key.toLowerCase()
    && event.metaKey === (shortcut.primary === true && platform === 'darwin')
    && event.ctrlKey === (shortcut.primary === true && platform === 'win32')
    && event.shiftKey === (shortcut.shift === true)
    && event.altKey === (shortcut.alt === true);
}

export function workbenchCommandShortcutLabel(
  commandId: WorkbenchShortcutCommandId,
  platform: DebruteProductPlatform
): string | undefined {
  const shortcut = workbenchCommandShortcut(commandId, platform);
  if (!shortcut) {
    return undefined;
  }
  const key = shortcut.key === 'Backspace'
    ? platform === 'darwin' ? '⌫' : 'Backspace'
    : shortcut.key === 'Delete'
      ? 'Delete'
      : shortcut.key.toUpperCase();
  if (platform === 'darwin') {
    return `${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${shortcut.primary ? '⌘' : ''}${key}`;
  }
  return [
    shortcut.primary ? 'Ctrl' : undefined,
    shortcut.alt ? 'Alt' : undefined,
    shortcut.shift ? 'Shift' : undefined,
    key
  ].filter(Boolean).join('+');
}

export function workbenchCommandShortcutAccelerator(
  commandId: WorkbenchShortcutCommandId,
  platform: DebruteProductPlatform
): string | undefined {
  const shortcut = workbenchCommandShortcut(commandId, platform);
  if (!shortcut) {
    return undefined;
  }
  const primary = shortcut.primary
    ? platform === 'darwin' && shortcut.key === 'Backspace' ? 'Command' : 'CmdOrCtrl'
    : undefined;
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  return [primary, shortcut.alt ? 'Alt' : undefined, shortcut.shift ? 'Shift' : undefined, key]
    .filter(Boolean)
    .join('+');
}

function workbenchCommandShortcut(
  commandId: WorkbenchShortcutCommandId,
  platform: DebruteProductPlatform
): WorkbenchCommandShortcut | undefined {
  switch (commandId) {
    case 'window.new': return { key: 'n', primary: true };
    case 'project.open-picker': return { key: 'o', primary: true };
    case 'window.close': return { key: 'w', primary: true };
    case 'edit.undo': return { key: 'z', primary: true };
    case 'edit.redo': return platform === 'darwin'
      ? { key: 'z', primary: true, shift: true }
      : { key: 'y', primary: true };
    case 'edit.cut': return { key: 'x', primary: true };
    case 'edit.copy': return { key: 'c', primary: true };
    case 'edit.paste': return { key: 'v', primary: true };
    case 'edit.paste-and-match-style': return { key: 'v', primary: true, shift: true };
    case 'edit.delete': return platform === 'darwin'
      ? { key: 'Backspace', primary: true }
      : { key: 'Delete' };
    case 'edit.delete-permanently': return platform === 'darwin'
      ? { key: 'Backspace', primary: true, alt: true }
      : { key: 'Delete', shift: true };
    case 'edit.select-all': return { key: 'a', primary: true };
    case 'view.reload': return { key: 'r', primary: true };
    case 'view.toggle-devtools': return platform === 'darwin'
      ? { key: 'i', primary: true, alt: true }
      : { key: 'i', primary: true, shift: true };
    case 'project.open-path': return undefined;
  }
}
