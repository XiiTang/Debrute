import { describe, expect, it } from 'vitest';
import {
  axisCliAssetName,
  resolveAxisCliPaths,
  resolveAxisCliTarget
} from '../apps/desktop/src/electron/axis-cli/axisCliPaths';

describe('Axis CLI install paths', () => {
  it('uses AXIS-owned user directories and fixed asset names', () => {
    const paths = resolveAxisCliPaths({
      homeDir: '/Users/test',
      platform: 'darwin',
      arch: 'arm64'
    });

    expect(paths.binDir).toBe('/Users/test/.axis/bin');
    expect(paths.commandPath).toBe('/Users/test/.axis/bin/axis');
    expect(paths.installRoot).toBe('/Users/test/.axis/cli');
    expect(paths.releaseDir('0.2.0')).toBe('/Users/test/.axis/cli/releases/0.2.0-darwin-arm64');
    expect(axisCliAssetName('0.2.0', paths.target)).toBe('axis-cli-0.2.0-darwin-arm64.tar.gz');
  });

  it('maps supported release targets explicitly', () => {
    expect(resolveAxisCliTarget('linux', 'x64')).toEqual({
      id: 'linux-x64',
      executableName: 'axis',
      archiveExtension: 'tar.gz'
    });
    expect(resolveAxisCliTarget('win32', 'arm64')).toEqual({
      id: 'windows-arm64',
      executableName: 'axis.exe',
      archiveExtension: 'zip'
    });
    expect(() => resolveAxisCliTarget('freebsd', 'x64')).toThrow('Unsupported AXIS CLI platform');
  });

  it('uses a command script path for Windows local development launchers', () => {
    const paths = resolveAxisCliPaths({
      homeDir: 'C:\\Users\\test',
      platform: 'win32',
      arch: 'x64'
    });

    expect(paths.commandPath).toBe('C:\\Users\\test\\.axis\\bin\\axis.exe');
    expect(paths.developmentCommandPath).toBe('C:\\Users\\test\\.axis\\bin\\axis.cmd');
  });
});
