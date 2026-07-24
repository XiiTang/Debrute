import { posix, win32 } from 'node:path';
import type { DebruteProductPlatform } from '@debrute/app-protocol';

export interface DesktopRuntimeLaunchConfiguration {
  entrypoint: string;
  arguments: string[];
  webAssetsDirectory: string;
}

export function desktopRuntimeLaunchConfiguration(input: {
  configuredEntrypoint?: string;
  configuredWebAssetsDirectory?: string;
  resourcesPath: string;
  homePath: string;
  executablePath: string;
  platform: DebruteProductPlatform;
}): DesktopRuntimeLaunchConfiguration {
  if (Boolean(input.configuredEntrypoint) !== Boolean(input.configuredWebAssetsDirectory)) {
    throw new Error('Configured Runtime entrypoint and Web assets directory must be provided together.');
  }
  if (input.configuredEntrypoint && input.configuredWebAssetsDirectory) {
    return {
      entrypoint: input.configuredEntrypoint,
      arguments: input.platform === 'darwin'
        ? []
        : ['--stable-runtime-entrypoint', input.configuredEntrypoint],
      webAssetsDirectory: input.configuredWebAssetsDirectory
    };
  }
  const path = input.platform === 'darwin' ? posix : win32;
  const runtimeExecutable = input.platform === 'darwin'
    ? path.join('runtime', 'Debrute Runtime.app', 'Contents', 'MacOS', 'debrute-runtime')
    : path.join('runtime', 'debrute-runtime.exe');
  const seed = path.join(input.resourcesPath, 'product-seed');
  const debruteHome = path.join(input.homePath, '.debrute');
  return {
    entrypoint: path.join(seed, runtimeExecutable),
    arguments: [
      'bootstrap',
      '--seed', seed,
      '--product-root', path.join(debruteHome, 'products'),
      '--bin-directory', path.join(debruteHome, 'bin'),
      '--desktop-entrypoint', input.executablePath,
      '--desktop-arguments-json', '[]'
    ],
    webAssetsDirectory: path.join(seed, 'web')
  };
}
