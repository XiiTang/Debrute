import { describe, expect, it } from 'vitest';
import {
  workbenchCommandShortcutAccelerator,
  workbenchCommandShortcutLabel,
  workbenchCommandShortcutMatches
} from './workbenchChrome.js';

describe('Workbench command shortcuts', () => {
  it('derives macOS matching, presentation, and Electron accelerator from one command', () => {
    expect(workbenchCommandShortcutMatches('project.open-picker', {
      key: 'o', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false
    }, 'darwin')).toBe(true);
    expect(workbenchCommandShortcutMatches('project.open-picker', {
      key: 'o', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false
    }, 'darwin')).toBe(false);
    expect(workbenchCommandShortcutLabel('project.open-picker', 'darwin')).toBe('⌘O');
    expect(workbenchCommandShortcutAccelerator('project.open-picker', 'darwin')).toBe('CmdOrCtrl+O');
  });

  it('keeps platform-specific redo and delete commands exact', () => {
    expect(workbenchCommandShortcutLabel('edit.redo', 'darwin')).toBe('⇧⌘Z');
    expect(workbenchCommandShortcutAccelerator('edit.redo', 'darwin')).toBe('CmdOrCtrl+Shift+Z');
    expect(workbenchCommandShortcutLabel('edit.redo', 'win32')).toBe('Ctrl+Y');
    expect(workbenchCommandShortcutAccelerator('edit.redo', 'win32')).toBe('CmdOrCtrl+Y');
    expect(workbenchCommandShortcutMatches('edit.delete', {
      key: 'Delete', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false
    }, 'win32')).toBe(true);
    expect(workbenchCommandShortcutMatches('edit.delete', {
      key: 'Delete', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false
    }, 'win32')).toBe(false);
    expect(workbenchCommandShortcutLabel('edit.delete', 'darwin')).toBe('⌘⌫');
    expect(workbenchCommandShortcutAccelerator('edit.delete', 'darwin')).toBe('Command+Backspace');
    expect(workbenchCommandShortcutMatches('edit.delete-permanently', {
      key: 'Backspace', metaKey: true, ctrlKey: false, shiftKey: false, altKey: true
    }, 'darwin')).toBe(true);
    expect(workbenchCommandShortcutMatches('edit.delete-permanently', {
      key: 'Delete', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false
    }, 'win32')).toBe(true);
    expect(workbenchCommandShortcutMatches('edit.delete-permanently', {
      key: 'Delete', metaKey: false, ctrlKey: true, shiftKey: true, altKey: false
    }, 'win32')).toBe(false);
  });

  it('returns no shortcut for commands without an active key binding', () => {
    expect(workbenchCommandShortcutLabel('project.open-path', 'darwin')).toBeUndefined();
    expect(workbenchCommandShortcutAccelerator('project.open-path', 'win32')).toBeUndefined();
    expect(workbenchCommandShortcutMatches('project.open-path', {
      key: 'o', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false
    }, 'darwin')).toBe(false);
  });
});
