import { describe, expect, it } from 'vitest';
import { desktopRuntimeLaunchConfiguration } from './desktopProductBootstrap.js';

describe('desktopRuntimeLaunchConfiguration', () => {
  it('keeps source development on the explicitly built Rust Runtime and Vite assets', () => {
    expect(desktopRuntimeLaunchConfiguration({
      configuredEntrypoint: '/repo/target/debug/debrute-runtime',
      configuredArguments: ['--source-dev'],
      configuredWebAssetsDirectory: '/repo/apps/web/dist',
      sourceWebAssetsDirectory: '/repo/apps/desktop/dist',
      resourcesPath: '/Applications/Debrute.app/Contents/Resources',
      homePath: '/Users/person',
      executablePath: '/Applications/Debrute.app/Contents/MacOS/Debrute',
      applicationPath: '/repo/apps/desktop',
      packaged: false,
      platform: 'darwin'
    })).toEqual({
      entrypoint: '/repo/target/debug/debrute-runtime',
      arguments: ['--source-dev'],
      webAssetsDirectory: '/repo/apps/web/dist'
    });
  });

  it('launches the macOS Product seed only in closed bootstrap mode', () => {
    expect(desktopRuntimeLaunchConfiguration({
      configuredArguments: [],
      sourceWebAssetsDirectory: '/unused',
      resourcesPath: '/Applications/Debrute.app/Contents/Resources',
      homePath: '/Users/person',
      executablePath: '/Applications/Debrute.app/Contents/MacOS/Debrute',
      applicationPath: '/Applications/Debrute.app/Contents/Resources/app.asar',
      packaged: true,
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
      configuredArguments: [],
      sourceWebAssetsDirectory: 'C:\\unused',
      resourcesPath: 'C:\\Program Files\\Debrute\\resources',
      homePath: 'C:\\Users\\person',
      executablePath: 'C:\\Program Files\\Debrute\\Debrute.exe',
      applicationPath: 'C:\\repo\\apps\\desktop',
      packaged: true,
      platform: 'win32'
    })).toMatchObject({
      entrypoint: expect.stringMatching(/product-seed[\\/]runtime[\\/]debrute-runtime\.exe$/),
      arguments: expect.arrayContaining(['bootstrap', '--product-root', '--bin-directory'])
    });
  });
});
