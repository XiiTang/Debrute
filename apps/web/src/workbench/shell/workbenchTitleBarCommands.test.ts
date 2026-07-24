import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchApiClient } from '../../types';
import { executeTitleBarMenuCommand } from './workbenchTitleBarCommands';

describe('executeTitleBarMenuCommand', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports unsupported browser edit commands instead of silently no-oping', async () => {
    const execCommand = vi.fn();
    vi.stubGlobal('document', { execCommand });
    const notifications: string[] = [];

    await executeTitleBarMenuCommand({
      kind: 'command',
      id: 'edit.paste-and-match-style',
      label: 'Paste and Match Style',
      commandId: 'edit.paste-and-match-style',
      enabled: true
    }, {
      api: {} as WorkbenchApiClient,
      shell: undefined,
      notify: (message) => notifications.push(message),
      openProjectFromPicker: async () => undefined,
      openProjectRoot: async () => undefined,
      refreshTitleBarState: async () => undefined,
      commandUnavailableMessage: (label) => `${label} is not available in this host.`
    });

    expect(execCommand).not.toHaveBeenCalled();
    expect(notifications).toEqual(['Paste and Match Style is not available in this host.']);
  });

  it('keeps current-window Project opens in the renderer and delegates only new-window opens', async () => {
    const executeNativeMenuCommand = vi.fn(async () => ({ ok: true as const }));
    const openProjectFromPicker = vi.fn(async () => undefined);
    const context = {
      api: {} as WorkbenchApiClient,
      shell: { executeNativeMenuCommand },
      notify: vi.fn(),
      openProjectFromPicker,
      openProjectRoot: vi.fn(async () => undefined),
      refreshTitleBarState: vi.fn(async () => undefined),
      commandUnavailableMessage: (label: string) => label
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
