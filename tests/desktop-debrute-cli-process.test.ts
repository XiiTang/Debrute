import { describe, expect, it } from 'vitest';
import { debruteCliExecutionCommand } from '../apps/desktop/src/electron/debruteCliProcess';

describe('Desktop Debrute CLI process runner', () => {
  it('dispatches Windows cmd shims through cmd.exe instead of executing them directly', () => {
    const execution = debruteCliExecutionCommand({
      debrutePath: 'C:\\Users\\me\\.debrute\\bin\\debrute.cmd',
      args: ['skills', 'sync'],
      platform: 'win32',
      comSpec: 'C:\\Windows\\System32\\cmd.exe'
    });

    expect(execution).toEqual({
      executablePath: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'call "C:\\Users\\me\\.debrute\\bin\\debrute.cmd" "skills" "sync"']
    });
  });

  it('executes native binaries directly', () => {
    expect(debruteCliExecutionCommand({
      debrutePath: 'C:\\Users\\me\\.debrute\\cli\\0.2.0\\debrute.exe',
      args: ['--version'],
      platform: 'win32'
    })).toEqual({
      executablePath: 'C:\\Users\\me\\.debrute\\cli\\0.2.0\\debrute.exe',
      args: ['--version']
    });
    expect(debruteCliExecutionCommand({
      debrutePath: '/Users/me/.debrute/bin/debrute',
      args: ['--version'],
      platform: 'darwin'
    })).toEqual({
      executablePath: '/Users/me/.debrute/bin/debrute',
      args: ['--version']
    });
  });
});
