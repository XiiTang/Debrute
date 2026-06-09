import { describe, expect, it } from 'vitest';
import { projectTreeKeyboardCommandFromEvent } from './projectTreeKeyboardCommands';

describe('project tree keyboard commands', () => {
  it('maps copy, cut, paste, and cancel-cut shortcuts', () => {
    expect(projectTreeKeyboardCommandFromEvent({ key: 'c', metaKey: true }, 'darwin')).toBe('copy');
    expect(projectTreeKeyboardCommandFromEvent({ key: 'x', ctrlKey: true }, 'win32')).toBe('cut');
    expect(projectTreeKeyboardCommandFromEvent({ key: 'v', ctrlKey: true }, 'linux')).toBe('paste');
    expect(projectTreeKeyboardCommandFromEvent({ key: 'F2' }, 'linux')).toBe('rename');
    expect(projectTreeKeyboardCommandFromEvent({ key: 'Escape' }, 'darwin')).toBe('cancel-cut');
  });

  it('maps recoverable and permanent delete shortcuts', () => {
    expect(projectTreeKeyboardCommandFromEvent({ key: 'Delete' }, 'linux')).toBe('delete');
    expect(projectTreeKeyboardCommandFromEvent({ key: 'Backspace' }, 'darwin')).toBeUndefined();
    expect(projectTreeKeyboardCommandFromEvent({ key: 'Backspace', metaKey: true }, 'darwin')).toBe('delete');
    expect(projectTreeKeyboardCommandFromEvent({ key: 'Delete', shiftKey: true }, 'win32')).toBe('delete-permanently');
    expect(projectTreeKeyboardCommandFromEvent({ key: 'Delete', shiftKey: true }, 'darwin')).toBeUndefined();
    expect(projectTreeKeyboardCommandFromEvent({ key: 'Backspace', metaKey: true, altKey: true }, 'darwin')).toBe('delete-permanently');
  });

  it('does not treat modified Shift+Delete as the permanent delete shortcut', () => {
    expect(projectTreeKeyboardCommandFromEvent({ key: 'Delete', shiftKey: true, ctrlKey: true }, 'win32')).toBeUndefined();
    expect(projectTreeKeyboardCommandFromEvent({ key: 'Delete', shiftKey: true, altKey: true }, 'linux')).toBeUndefined();
    expect(projectTreeKeyboardCommandFromEvent({ key: 'Delete', shiftKey: true, metaKey: true }, 'linux')).toBeUndefined();
  });

  it('ignores shortcuts from editable targets', () => {
    const input = { tagName: 'INPUT', isContentEditable: false };
    expect(projectTreeKeyboardCommandFromEvent({ key: 'c', metaKey: true, target: input }, 'darwin')).toBeUndefined();
    expect(projectTreeKeyboardCommandFromEvent({ key: 'Delete', target: input }, 'linux')).toBeUndefined();
    expect(projectTreeKeyboardCommandFromEvent({ key: 'F2', target: input }, 'linux')).toBeUndefined();
  });
});
