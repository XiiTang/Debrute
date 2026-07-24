import { describe, expect, it, vi } from 'vitest';
import { parseDesktopOpenIntent, syncNativeRecentProjects } from './nativeRecentProjects';

describe('native recent projects', () => {
  it('syncs macOS Dock recent documents from the stored project history', () => {
    const addRecentDocument = vi.fn();
    const clearRecentDocuments = vi.fn();

    syncNativeRecentProjects(
      { addRecentDocument, clearRecentDocuments, setJumpList: vi.fn(() => 'ok' as const) },
      'darwin',
      '/Applications/Debrute.app/Contents/MacOS/Debrute',
      ['/projects/alpha', '/projects/beta']
    );

    expect(clearRecentDocuments).toHaveBeenCalledTimes(1);
    expect(addRecentDocument.mock.calls.map((call) => call[0])).toEqual([
      '/projects/beta',
      '/projects/alpha'
    ]);
  });

  it('builds Windows Jump List tasks for new windows and recent projects', () => {
    const setJumpList = vi.fn(() => 'ok' as const);

    syncNativeRecentProjects(
      { setJumpList, addRecentDocument: vi.fn(), clearRecentDocuments: vi.fn() },
      'win32',
      'C:\\Program Files\\Debrute\\Debrute.exe',
      ['C:\\Projects\\Alpha Project']
    );

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

  it('fails when Windows rejects the Jump List', () => {
    expect(() => syncNativeRecentProjects(
      {
        setJumpList: vi.fn(() => 'fileTypeRegistrationError' as const),
        addRecentDocument: vi.fn(),
        clearRecentDocuments: vi.fn()
      },
      'win32',
      'C:\\Program Files\\Debrute\\Debrute.exe',
      []
    )).toThrow('Windows rejected the Debrute Jump List: fileTypeRegistrationError');
  });

  it('parses desktop open intents from native launch arguments', () => {
    expect(parseDesktopOpenIntent(['Debrute.exe', '--new-window'])).toEqual({ kind: 'new-window' });
    expect(parseDesktopOpenIntent(['Debrute.exe', '--open-project=C:\\Projects\\Alpha Project'])).toEqual({
      kind: 'open-project-path',
      projectRoot: 'C:\\Projects\\Alpha Project'
    });
    expect(parseDesktopOpenIntent(['Electron', '.', '--allow-file-access-from-files', '--open-project=/tmp/Alpha Project'])).toEqual({
      kind: 'open-project-path',
      projectRoot: '/tmp/Alpha Project'
    });
    expect(parseDesktopOpenIntent(['Debrute.exe', '--open-project', 'C:\\Projects\\Alpha Project'])).toBeUndefined();
    expect(parseDesktopOpenIntent(['Debrute.exe'])).toBeUndefined();
  });
});
