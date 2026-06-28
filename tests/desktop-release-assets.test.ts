import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isDirectCliInvocation,
  requiredDesktopReleaseAssets
} from '../scripts/desktop-release-assets.mjs';

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
    expect(() => requiredDesktopReleaseAssets('0.2.0', 'darwin', 'universal')).toThrow(/unsupported macos release arch/i);
    expect(requiredDesktopReleaseAssets('0.2.0', 'win32', 'x64')).toEqual([
      'debrute-desktop-0.2.0-windows-x64.exe'
    ]);
  });

  it('copies the runtime host bundle into the Electron runtime bundle', () => {
    const script = readFileSync(join(process.cwd(), 'apps/desktop/scripts/bundle-electron.mjs'), 'utf8');

    expect(script).toContain("['--filter', '@debrute/runtime-host', 'build']");
    expect(script).toContain("cp('../runtime-host/bundle/runtime-host.cjs', 'dist-electron/runtime-host.cjs')");
    expect(script).toContain("cp('build/tray_icon_template.png', 'dist-electron/tray_icon_template.png')");
    expect(script).toContain("cp('build/tray_icon_template@2x.png', 'dist-electron/tray_icon_template@2x.png')");
    for (const status of ['starting', 'running', 'degraded', 'stopped', 'error']) {
      expect(script).toContain(`cp(\`build/tray_icon_\${status}.png\`, \`dist-electron/tray_icon_\${status}.png\`)`);
    }
  });
});
