import { describe, expect, it, vi } from 'vitest';
import { createNodeNativeShell } from '../apps/daemon/src/http/nativeShell';

describe('daemon native shell adapter', () => {
  it('reveals macOS paths with Finder selection semantics', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const shell = createNodeNativeShell({ platform: 'darwin', execFile });

    await shell.showItemInFolder('/tmp/debrute-project/brief.md');

    expect(execFile).toHaveBeenCalledWith('open', ['-R', '/tmp/debrute-project/brief.md']);
  });

  it('opens containing folders on Linux through xdg-open', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const shell = createNodeNativeShell({ platform: 'linux', execFile });

    await shell.openPath('/tmp/debrute-project/assets');

    expect(execFile).toHaveBeenCalledWith('xdg-open', ['/tmp/debrute-project/assets']);
  });

  it('moves macOS paths to Trash through Finder without permanent delete fallback', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const shell = createNodeNativeShell({ platform: 'darwin', execFile });

    await shell.trashItem('/tmp/debrute-project/brief "draft".md');

    expect(execFile).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "Finder" to delete POSIX file "/tmp/debrute-project/brief \\"draft\\".md"'
    ]);
  });

  it('propagates native command failures', async () => {
    const execFile = vi.fn(async () => {
      throw new Error('xdg-open failed');
    });
    const shell = createNodeNativeShell({ platform: 'linux', execFile });

    await expect(shell.openPath('/tmp/debrute-project/assets')).rejects.toThrow('xdg-open failed');
  });

  it('chooses macOS project directories with the system folder picker', async () => {
    const execFile = vi.fn(async () => ({ stdout: '/Users/me/Project A\n', stderr: '' }));
    const shell = createNodeNativeShell({ platform: 'darwin', execFile });

    await expect(shell.chooseDirectory()).resolves.toBe('/Users/me/Project A');

    expect(execFile).toHaveBeenCalledWith('osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "Open Debrute Project")'
    ]);
  });

  it('chooses Windows project directories with the system folder picker', async () => {
    const execFile = vi.fn(async () => ({ stdout: 'C:\\Users\\me\\Project A\r\n', stderr: '' }));
    const shell = createNodeNativeShell({ platform: 'win32', execFile });

    await expect(shell.chooseDirectory()).resolves.toBe('C:\\Users\\me\\Project A');

    expect(execFile).toHaveBeenCalledWith('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$dialog.Description = "Open Debrute Project"',
        '$dialog.ShowNewFolderButton = $true',
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }'
      ].join('; ')
    ]);
  });

  it('chooses Linux project directories with zenity', async () => {
    const execFile = vi.fn(async () => ({ stdout: '/home/me/project-a\n', stderr: '' }));
    const shell = createNodeNativeShell({ platform: 'linux', execFile });

    await expect(shell.chooseDirectory()).resolves.toBe('/home/me/project-a');

    expect(execFile).toHaveBeenCalledWith('zenity', [
      '--file-selection',
      '--directory',
      '--title',
      'Open Debrute Project'
    ]);
  });

  it('treats native picker cancel as no selected directory', async () => {
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error('User canceled.'), { code: 1, stderr: 'User canceled.' });
    });
    const shell = createNodeNativeShell({ platform: 'darwin', execFile });

    await expect(shell.chooseDirectory()).resolves.toBeUndefined();
  });

  it('treats blank native picker exit-code cancel as no selected directory', async () => {
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error(''), { code: 1, stderr: '' });
    });
    const shell = createNodeNativeShell({ platform: 'linux', execFile });

    await expect(shell.chooseDirectory()).resolves.toBeUndefined();
  });

  it('propagates native picker command failures that are not cancelation', async () => {
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error('zenity missing'), { code: 127, stderr: 'zenity missing' });
    });
    const shell = createNodeNativeShell({ platform: 'linux', execFile });

    await expect(shell.chooseDirectory()).rejects.toThrow('zenity missing');
  });
});
