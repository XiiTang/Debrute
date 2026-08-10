import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  desktopRuntimeLaunchConfiguration,
  ensureInstalledDesktopStateDirectories,
  installedDesktopStatePaths
} from './desktopInstalledProduct.js';

describe('desktopRuntimeLaunchConfiguration', () => {
  it('keeps all Electron-owned state inside the Debrute removal root', () => {
    expect(installedDesktopStatePaths('/Users/person', 'darwin')).toEqual({
      userData: '/Users/person/.debrute/desktop/user-data',
      logs: '/Users/person/.debrute/desktop/logs',
      cache: '/Users/person/.debrute/desktop/cache',
      sessionData: '/Users/person/.debrute/desktop/session-data',
      crashDumps: '/Users/person/.debrute/desktop/crash-dumps'
    });
  });

  it('creates every packaged Electron state directory before setPath uses it', () => {
    const home = mkdtempSync(join(tmpdir(), 'debrute-desktop-state-'));
    try {
      const platform = process.platform === 'win32' ? 'win32' : 'darwin';
      const paths = installedDesktopStatePaths(home, platform);
      ensureInstalledDesktopStateDirectories(paths);
      ensureInstalledDesktopStateDirectories(paths);
      for (const directory of Object.values(paths)) {
        expect(statSync(directory).isDirectory()).toBe(true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps source development on the explicitly built Rust Runtime and Vite assets', () => {
    expect(desktopRuntimeLaunchConfiguration({
      configuredEntrypoint: '/repo/target/debug/debrute-runtime',
      configuredWebAssetsDirectory: '/repo/apps/web/dist',
      homePath: '/Users/person',
      platform: 'darwin'
    })).toEqual({
      entrypoint: '/repo/target/debug/debrute-runtime',
      arguments: [],
      webAssetsDirectory: '/repo/apps/web/dist'
    });
  });

  it('launches only the already-installed macOS Product', () => {
    expect(desktopRuntimeLaunchConfiguration({
      homePath: '/Users/person',
      platform: 'darwin'
    })).toEqual({
      entrypoint: '/Users/person/.debrute/bin/debrute-runtime',
      arguments: [],
      webAssetsDirectory: '/Users/person/.debrute/products/current/web',
      failureProbe: {
        entrypoint: '/Users/person/.debrute/products/current/runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime',
        productRoot: '/Users/person/.debrute/products'
      }
    });
  });

  it('launches only the already-installed Windows Product', () => {
    expect(desktopRuntimeLaunchConfiguration({
      homePath: 'C:\\Users\\person',
      platform: 'win32'
    })).toEqual({
      entrypoint: 'C:\\Users\\person\\.debrute\\products\\current\\runtime\\debrute-runtime.exe',
      arguments: [
        '--stable-runtime-entrypoint',
        'C:\\Users\\person\\.debrute\\products\\current\\runtime\\debrute-runtime.exe'
      ],
      webAssetsDirectory: 'C:\\Users\\person\\.debrute\\products\\current\\web',
      failureProbe: {
        entrypoint: 'C:\\Users\\person\\.debrute\\products\\current\\runtime\\debrute-runtime.exe',
        productRoot: 'C:\\Users\\person\\.debrute\\products'
      }
    });
  });

  it('requires source-development Runtime and Web assets to be configured together', () => {
    expect(() => desktopRuntimeLaunchConfiguration({
      configuredEntrypoint: '/repo/target/debug/debrute-runtime',
      homePath: '/Users/person',
      platform: 'darwin'
    })).toThrow(/must be provided together/i);
  });
});
