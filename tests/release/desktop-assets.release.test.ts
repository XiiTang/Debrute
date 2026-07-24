import { describe, expect, it } from 'vitest';
import {
  isDirectCliInvocation,
  requiredDesktopReleaseAssets
} from '../../scripts/desktop-release-assets.mjs';

describe('Desktop release asset script', () => {
  it('detects direct CLI invocation from Windows argv paths', () => {
    expect(isDirectCliInvocation(
      'file:///D:/a/Debrute/Debrute/scripts/desktop-release-assets.mjs',
      'D:\\a\\Debrute\\Debrute\\scripts\\desktop-release-assets.mjs'
    )).toBe(true);
  });

  it('verifies final Electron Builder asset names instead of renaming update metadata after build', () => {
    expect(requiredDesktopReleaseAssets('0.2.0', 'darwin', 'arm64')).toEqual([
      'debrute-desktop-0.2.0-macos-arm64.dmg'
    ]);
    expect(() => requiredDesktopReleaseAssets('0.2.0', 'darwin', 'universal' as NodeJS.Architecture)).toThrow(/unsupported macos release arch/i);
    expect(requiredDesktopReleaseAssets('0.2.0', 'win32', 'x64')).toEqual([
      'debrute-desktop-0.2.0-windows-x64.exe'
    ]);
  });
});
