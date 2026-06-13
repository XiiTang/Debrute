import { describe, expect, it, vi } from 'vitest';
import { buildNativeRecentProjectSync, parseDesktopOpenIntent } from './nativeRecentProjects';

describe('native recent projects', () => {
  it('syncs macOS Dock recent documents from the stored project history', () => {
    const sync = buildNativeRecentProjectSync({
      platform: 'darwin',
      execPath: '/Applications/Debrute.app/Contents/MacOS/Debrute',
      recentProjectRoots: ['/projects/alpha', '/projects/beta']
    });
    const addRecentDocument = vi.fn();
    const clearRecentDocuments = vi.fn();

    sync.apply({ addRecentDocument, clearRecentDocuments });

    expect(clearRecentDocuments).toHaveBeenCalledTimes(1);
    expect(addRecentDocument.mock.calls.map((call) => call[0])).toEqual([
      '/projects/beta',
      '/projects/alpha'
    ]);
  });

  it('builds Windows Jump List tasks for new windows and recent projects', () => {
    const sync = buildNativeRecentProjectSync({
      platform: 'win32',
      execPath: 'C:\\Program Files\\Debrute\\Debrute.exe',
      recentProjectRoots: ['C:\\Projects\\Alpha Project']
    });
    const setJumpList = vi.fn();

    sync.apply({ setJumpList });

    expect(setJumpList).toHaveBeenCalledWith([
      {
        type: 'tasks',
        items: [expect.objectContaining({
          title: 'New Window',
          args: '--new-window'
        })]
      },
      {
        type: 'custom',
        name: 'Recent Projects',
        items: [expect.objectContaining({
          title: 'Alpha Project',
          description: 'C:\\Projects\\Alpha Project',
          args: '--open-project="C:\\Projects\\Alpha Project"'
        })]
      }
    ]);
  });

  it('parses desktop open intents from native launch arguments', () => {
    expect(parseDesktopOpenIntent(['Debrute.exe', '--new-window'])).toEqual({ kind: 'new-window' });
    expect(parseDesktopOpenIntent(['Debrute.exe', '--open-project=C:\\Projects\\Alpha Project'])).toEqual({
      kind: 'open-project',
      projectRoot: 'C:\\Projects\\Alpha Project'
    });
    expect(parseDesktopOpenIntent(['Electron', '.', '--allow-file-access-from-files', '--open-project=/tmp/Alpha Project'])).toEqual({
      kind: 'open-project',
      projectRoot: '/tmp/Alpha Project'
    });
    expect(parseDesktopOpenIntent(['Debrute.exe', '--open-project', 'C:\\Projects\\Alpha Project'])).toBeUndefined();
    expect(parseDesktopOpenIntent(['Debrute.exe'])).toBeUndefined();
  });
});
