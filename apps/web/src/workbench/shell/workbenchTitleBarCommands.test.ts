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
      refreshTitleBarState: async () => undefined
    });

    expect(execCommand).not.toHaveBeenCalled();
    expect(notifications).toEqual(['paste and match style is not available in this host.']);
  });
});
