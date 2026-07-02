import { describe, expect, it, vi } from 'vitest';
import { createProductUpdatePlatformVerifier } from '../apps/daemon/src/product/ProductUpdatePlatformVerifier';

describe('product update platform verifier', () => {
  it('verifies macOS DMG identity before replacement', async () => {
    const calls: string[] = [];
    const verifier = createProductUpdatePlatformVerifier({
      execFile: vi.fn(async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);
        if (file === 'hdiutil' && args[0] === 'attach') {
          return { stdout: '/dev/disk4s1\tApple_HFS\t/Volumes/Debrute\n', stderr: '' };
        }
        if (file === 'find') {
          return { stdout: '/Volumes/Debrute/Debrute.app\n', stderr: '' };
        }
        if (file === 'plutil') {
          return { stdout: 'io.github.xiitang.debrute\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      })
    });

    await verifier({
      platform: 'darwin',
      assetPath: '/tmp/debrute.dmg',
      asset: {
        platform: 'darwin',
        arch: 'arm64',
        name: 'debrute-desktop-0.3.0-macos-arm64.dmg',
        url: 'https://github.com/xiitang/debrute/releases/download/v0.3.0/debrute-desktop-0.3.0-macos-arm64.dmg',
        sha256: 'a'.repeat(64),
        sizeBytes: 1
      }
    });

    expect(calls).toEqual([
      'hdiutil attach -nobrowse -readonly /tmp/debrute.dmg',
      'find /Volumes/Debrute -maxdepth 1 -name *.app -type d -print -quit',
      'plutil -extract CFBundleIdentifier raw /Volumes/Debrute/Debrute.app/Contents/Info.plist',
      'codesign --verify --deep --strict --verbose=2 /Volumes/Debrute/Debrute.app',
      'spctl -a -t exec -vv /Volumes/Debrute/Debrute.app',
      'xcrun stapler validate /Volumes/Debrute/Debrute.app',
      'hdiutil detach /Volumes/Debrute'
    ]);
  });

  it('does not run platform commands for Windows and Linux assets', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const verifier = createProductUpdatePlatformVerifier({ execFile });

    await verifier({
      platform: 'linux',
      assetPath: '/tmp/debrute.AppImage',
      asset: {
        platform: 'linux',
        arch: 'x64',
        name: 'debrute-desktop-0.3.0-linux-x64.AppImage',
        url: 'https://github.com/xiitang/debrute/releases/download/v0.3.0/debrute-desktop-0.3.0-linux-x64.AppImage',
        sha256: 'a'.repeat(64),
        sizeBytes: 1
      }
    });

    expect(execFile).not.toHaveBeenCalled();
  });
});
