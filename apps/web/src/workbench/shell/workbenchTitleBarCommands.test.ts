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

  it('routes every Desktop Project open through the native activation commands', async () => {
    const executeNativeMenuCommand = vi.fn(async () => ({ result: 'completed' as const }));
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
      kind: 'command',
      id: 'recent:alpha',
      label: '/projects/alpha',
      commandId: 'project.open-recent',
      enabled: true,
      payload: { projectRoot: '/projects/alpha' }
    }, context);

    expect(openProjectFromPicker).not.toHaveBeenCalled();
    expect(executeNativeMenuCommand.mock.calls).toEqual([
      [{ commandId: 'project.open-picker' }],
      [{ commandId: 'project.open-path', projectRoot: '/projects/alpha' }]
    ]);
  });

  it('keeps browser Project opens in the current tab', async () => {
    const openProjectRoot = vi.fn(async () => undefined);
    const openProjectFromPicker = vi.fn(async () => undefined);
    const context = {
      api: {} as WorkbenchApiClient,
      shell: undefined,
      openProjectFromPicker,
      openProjectRoot
    };

    await executeTitleBarMenuCommand({
      kind: 'command', id: 'open', label: 'Open Project', commandId: 'project.open-picker', enabled: true
    }, context);
    await executeTitleBarMenuCommand({
      kind: 'command',
      id: 'recent:alpha',
      label: '/projects/alpha',
      commandId: 'project.open-recent',
      enabled: true,
      payload: { bindingId: 'alpha', projectRoot: '/projects/alpha' }
    }, context);

    expect(openProjectFromPicker).toHaveBeenCalledOnce();
    expect(openProjectRoot).toHaveBeenCalledWith('/projects/alpha');
  });
});

function shellApiFixture(overrides: Partial<DebruteShellApi>): DebruteShellApi {
  return {
    getNativeWindowState: async () => ({ maximized: false }),
    minimizeNativeWindow: async () => ({ maximized: false }),
    toggleMaximizeNativeWindow: async () => ({ maximized: true }),
    closeNativeWindow: async () => ({ ok: true }),
    executeNativeMenuCommand: async () => ({ result: 'completed' }),
    takeDesktopLaunchContext: async () => undefined,
    onNativeWindowStateChanged: () => () => undefined,
    onNativeEditCommand: () => () => undefined,
    onNativeProjectOpenRequested: () => () => undefined,
    getDroppedFilePath: () => undefined,
    ...overrides
  };
}
