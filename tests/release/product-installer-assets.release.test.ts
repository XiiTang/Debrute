import { describe, expect, it } from 'vitest';
import {
  isDirectCliInvocation,
  requiredProductInstallerAssets
} from '../../scripts/product-installer-assets.mjs';

describe('Product Installer asset script', () => {
  it('detects direct CLI invocation from Windows argv paths', () => {
    expect(isDirectCliInvocation(
      'file:///D:/a/Debrute/Debrute/scripts/product-installer-assets.mjs',
      'D:\\a\\Debrute\\Debrute\\scripts\\product-installer-assets.mjs'
    )).toBe(true);
  });

  it('verifies final Electron Builder asset names instead of renaming update metadata after build', () => {
    expect(requiredProductInstallerAssets('0.2.0', 'darwin', 'arm64')).toEqual([
      'debrute-installer-0.2.0-macos-arm64.dmg'
    ]);
    expect(() => requiredProductInstallerAssets('0.2.0', 'darwin', 'universal' as NodeJS.Architecture)).toThrow(/unsupported macos release arch/i);
    expect(requiredProductInstallerAssets('0.2.0', 'win32', 'x64')).toEqual([
      'debrute-installer-0.2.0-windows-x64.exe'
    ]);
  });
});
