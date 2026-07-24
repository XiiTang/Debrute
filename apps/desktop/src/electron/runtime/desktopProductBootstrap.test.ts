import { describe, expect, it } from 'vitest';
import { desktopRuntimeLaunchConfiguration } from './desktopProductBootstrap.js';

describe('desktopRuntimeLaunchConfiguration', () => {
  it('keeps source development on the explicitly built Rust Runtime and Vite assets', () => {
    expect(desktopRuntimeLaunchConfiguration({
      configuredEntrypoint: '/repo/target/debug/debrute-runtime',
      configuredWebAssetsDirectory: '/repo/apps/web/dist',
      resourcesPath: '/Applications/Debrute.app/Contents/Resources',
      homePath: '/Users/person',
      executablePath: '/Applications/Debrute.app/Contents/MacOS/Debrute',
      platform: 'darwin'
    })).toEqual({
      entrypoint: '/repo/target/debug/debrute-runtime',
      arguments: [],
      webAssetsDirectory: '/repo/apps/web/dist'
    });
  });

  it('launches the macOS Product seed only in closed bootstrap mode', () => {
    expect(desktopRuntimeLaunchConfiguration({
      resourcesPath: '/Applications/Debrute.app/Contents/Resources',
      homePath: '/Users/person',
      executablePath: '/Applications/Debrute.app/Contents/MacOS/Debrute',
      platform: 'darwin'
    })).toEqual({
      entrypoint: '/Applications/Debrute.app/Contents/Resources/product-seed/runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime',
      arguments: [
        'bootstrap',
        '--seed', '/Applications/Debrute.app/Contents/Resources/product-seed',
        '--product-root', '/Users/person/.debrute/products',
        '--bin-directory', '/Users/person/.debrute/bin',
        '--desktop-entrypoint', '/Applications/Debrute.app/Contents/MacOS/Debrute',
        '--desktop-arguments-json', '[]'
      ],
      webAssetsDirectory: '/Applications/Debrute.app/Contents/Resources/product-seed/web'
    });
  });

  it('selects the Windows seed executable and stable Product root', () => {
    expect(desktopRuntimeLaunchConfiguration({
      resourcesPath: 'C:\\Program Files\\Debrute\\resources',
      homePath: 'C:\\Users\\person',
      executablePath: 'C:\\Program Files\\Debrute\\Debrute.exe',
      platform: 'win32'
    })).toMatchObject({
      entrypoint: expect.stringMatching(/product-seed[\\/]runtime[\\/]debrute-runtime\.exe$/),
      arguments: expect.arrayContaining(['bootstrap', '--product-root', '--bin-directory'])
    });
  });

  it('requires source-development Runtime and Web assets to be configured together', () => {
    expect(() => desktopRuntimeLaunchConfiguration({
      configuredEntrypoint: '/repo/target/debug/debrute-runtime',
      resourcesPath: '/Applications/Debrute.app/Contents/Resources',
      homePath: '/Users/person',
      executablePath: '/Applications/Debrute.app/Contents/MacOS/Debrute',
      platform: 'darwin'
    })).toThrow(/must be provided together/i);
  });
});
