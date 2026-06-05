import { describe, expect, it } from 'vitest';
import {
  debruteCliAssetName,
  debruteCliManagedPaths,
  debruteCliPlatform,
  debruteCliReleaseUrl,
  shellProfilePath,
  userPathEntry
} from '../apps/desktop/src/electron/debruteCliPaths';

describe('Desktop Debrute CLI paths', () => {
  it('maps Node platforms to public release platforms', () => {
    expect(debruteCliPlatform('darwin')).toBe('macos');
    expect(debruteCliPlatform('win32')).toBe('windows');
    expect(debruteCliPlatform('linux')).toBe('linux');
  });

  it('builds trusted GitHub Release asset names and URLs', () => {
    expect(debruteCliAssetName({ version: '0.2.0', platform: 'darwin', arch: 'arm64' })).toBe('debrute-cli-0.2.0-macos-arm64.tar.gz');
    expect(debruteCliAssetName({ version: '0.2.0', platform: 'win32', arch: 'x64' })).toBe('debrute-cli-0.2.0-windows-x64.zip');
    expect(debruteCliReleaseUrl({ version: '0.2.0', assetName: 'debrute-cli-0.2.0-macos-arm64.tar.gz' })).toBe(
      'https://github.com/XiiTang/Debrute/releases/download/v0.2.0/debrute-cli-0.2.0-macos-arm64.tar.gz'
    );
  });

  it('uses Debrute-owned user directories', () => {
    expect(debruteCliManagedPaths({ userHome: '/Users/me', version: '0.2.0', platform: 'darwin' })).toEqual({
      installDir: '/Users/me/.debrute/cli/0.2.0',
      executablePath: '/Users/me/.debrute/cli/0.2.0/debrute',
      binDir: '/Users/me/.debrute/bin',
      shimPath: '/Users/me/.debrute/bin/debrute',
      statePath: '/Users/me/.debrute/skills-state.json'
    });
    expect(debruteCliManagedPaths({ userHome: 'C:\\Users\\me', version: '0.2.0', platform: 'win32' }).shimPath).toContain('.debrute');
  });

  it('selects user shell profiles and PATH entries', () => {
    expect(shellProfilePath({ userHome: '/Users/me', platform: 'darwin', shell: '/bin/zsh' })).toBe('/Users/me/.zprofile');
    expect(shellProfilePath({ userHome: '/home/me', platform: 'linux', shell: '/bin/bash' })).toBe('/home/me/.bashrc');
    expect(userPathEntry({ userHome: '/Users/me' })).toBe('/Users/me/.debrute/bin');
  });
});
