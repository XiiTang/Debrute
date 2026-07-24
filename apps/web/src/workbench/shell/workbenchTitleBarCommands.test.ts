import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DebruteShellApi } from '@debrute/app-protocol';
import type { WorkbenchApiClient } from '../../types';
import { executeTitleBarMenuCommand } from './workbenchTitleBarCommands';

describe('executeTitleBarMenuCommand', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails when a native-only command reaches a browser menu', async () => {
    const execCommand = vi.fn();
    vi.stubGlobal('document', { execCommand });

    const execution = executeTitleBarMenuCommand({
      kind: 'command',
      id: 'edit.paste-and-match-style',
      label: 'Paste and Match Style',
      commandId: 'edit.paste-and-match-style',
      enabled: true
    }, {
      api: {} as WorkbenchApiClient,
      shell: undefined,
      openProjectFromPicker: async () => undefined,
      openProjectRoot: async () => undefined
    });

    await expect(execution).rejects.toThrow('Title-bar command requires the native Desktop shell');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('keeps current-window Project opens in the renderer and delegates only new-window opens', async () => {
    const executeNativeMenuCommand = vi.fn(async () => ({ ok: true as const }));
    const openProjectFromPicker = vi.fn(async () => undefined);
    const context = {
      api: {} as WorkbenchApiClient,
      shell: shellApiFixture({ executeNativeMenuCommand }),
      openProjectFromPicker,
      openProjectRoot: vi.fn(async () => undefined)
    };

    await executeTitleBarMenuCommand({
      kind: 'command', id: 'open', label: 'Open Project', commandId: 'project.open-picker', enabled: true
    }, context);
    await executeTitleBarMenuCommand({
      kind: 'command', id: 'open-new', label: 'Open Project in New Window', commandId: 'project.open-picker-new-window', enabled: true
    }, context);

    expect(openProjectFromPicker).toHaveBeenCalledTimes(1);
    expect(executeNativeMenuCommand).toHaveBeenCalledWith({
      commandId: 'project.open-picker-new-window'
    });
  });
});

function shellApiFixture(overrides: Partial<DebruteShellApi>): DebruteShellApi {
  return {
    getNativeWindowState: async () => ({ maximized: false }),
    minimizeNativeWindow: async () => ({ maximized: false }),
    toggleMaximizeNativeWindow: async () => ({ maximized: true }),
    closeNativeWindow: async () => ({ ok: true }),
    executeNativeMenuCommand: async () => ({ ok: true }),
    takeDesktopLaunchTicket: async () => undefined,
    onNativeWindowStateChanged: () => () => undefined,
    onOpenProjectRequested: () => () => undefined,
    getDroppedFilePath: () => undefined,
    ...overrides
  };
}
