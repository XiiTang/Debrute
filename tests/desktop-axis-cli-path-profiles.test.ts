import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AXIS_CLI_PATH_BLOCK,
  ensureWindowsAxisCliPath,
  ensurePosixAxisCliPath,
  readWindowsPathState,
  removeWindowsAxisCliPath,
  removePosixAxisCliPath,
  selectPosixProfilePath,
  updateWindowsUserPathValue
} from '../apps/desktop/src/electron/axis-cli/axisCliPathProfiles';

describe('Axis CLI PATH profiles', () => {
  it('selects the Codex-style shell profile path', () => {
    expect(selectPosixProfilePath({ homeDir: '/Users/test', platform: 'darwin', shell: '/bin/zsh' })).toBe('/Users/test/.zprofile');
    expect(selectPosixProfilePath({ homeDir: '/Users/test', platform: 'linux', shell: '/usr/bin/bash' })).toBe('/Users/test/.bashrc');
  });

  it('adds, rewrites, and removes only the managed POSIX PATH block', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'axis-path-'));
    const profilePath = join(homeDir, '.zprofile');
    await writeFile(profilePath, `export FOO=1\n${AXIS_CLI_PATH_BLOCK('/old')}\n`, 'utf8');

    await ensurePosixAxisCliPath({ profilePath, binDir: join(homeDir, '.axis/bin') });
    const updated = await readFile(profilePath, 'utf8');
    expect(updated).toContain('export FOO=1');
    expect(updated).toContain(`export PATH="${join(homeDir, '.axis/bin')}:$PATH"`);
    expect(updated).not.toContain('/old');

    await removePosixAxisCliPath(profilePath);
    expect(await readFile(profilePath, 'utf8')).toBe('export FOO=1\n');
  });

  it('updates the Windows user PATH value without duplicates', () => {
    expect(updateWindowsUserPathValue('C:\\Other', 'C:\\Users\\test\\.axis\\bin', true)).toBe('C:\\Users\\test\\.axis\\bin;C:\\Other');
    expect(updateWindowsUserPathValue('C:\\Users\\test\\.axis\\bin;C:\\Other', 'c:\\users\\test\\.axis\\bin', true)).toBe('C:\\Users\\test\\.axis\\bin;C:\\Other');
    expect(updateWindowsUserPathValue('C:\\Users\\test\\.axis\\bin;C:\\Other', 'C:\\Users\\test\\.axis\\bin', false)).toBe('C:\\Other');
  });

  it('persists Windows user PATH additions and removals through the user store', async () => {
    let userPath = 'C:\\Other';
    const writes: string[] = [];
    const store = {
      read: async () => userPath,
      write: async (value: string) => {
        writes.push(value);
        userPath = value;
      }
    };

    await ensureWindowsAxisCliPath(store, 'C:\\Users\\test\\.axis\\bin');
    expect(userPath).toBe('C:\\Users\\test\\.axis\\bin;C:\\Other');
    expect(writes).toEqual(['C:\\Users\\test\\.axis\\bin;C:\\Other']);
    await expect(readWindowsPathState(store, 'c:\\users\\test\\.axis\\bin')).resolves.toBe('configured');

    await removeWindowsAxisCliPath(store, 'C:\\Users\\test\\.axis\\bin');
    expect(userPath).toBe('C:\\Other');
  });

  it('creates parent profile directories when needed', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'axis-path-parent-'));
    const profilePath = join(homeDir, 'nested', '.profile');
    await ensurePosixAxisCliPath({ profilePath, binDir: join(homeDir, '.axis/bin') });
    expect(await readFile(profilePath, 'utf8')).toContain('# >>> AXIS CLI installer >>>');
  });
});
