import { mkdirSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { DebruteProductPlatform } from '@debrute/app-protocol';

export interface DesktopRuntimeLaunchConfiguration {
  entrypoint: string;
  arguments: string[];
  webAssetsDirectory: string;
  failureProbe?: {
    entrypoint: string;
    productRoot: string;
  };
}

export function installedDesktopStatePaths(
  homePath: string,
  platform: DebruteProductPlatform
): {
  userData: string;
  logs: string;
  cache: string;
  sessionData: string;
  crashDumps: string;
} {
  const path = platform === 'darwin' ? posix : win32;
  const root = path.join(homePath, '.debrute', 'desktop');
  return {
    userData: path.join(root, 'user-data'),
    logs: path.join(root, 'logs'),
    cache: path.join(root, 'cache'),
    sessionData: path.join(root, 'session-data'),
    crashDumps: path.join(root, 'crash-dumps')
  };
}

export function ensureInstalledDesktopStateDirectories(
  paths: ReturnType<typeof installedDesktopStatePaths>
): void {
  for (const directory of Object.values(paths)) {
    mkdirSync(directory, { recursive: true });
  }
}

export function desktopRuntimeLaunchConfiguration(input: {
  configuredEntrypoint?: string;
  configuredWebAssetsDirectory?: string;
  homePath: string;
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
  const debruteHome = path.join(input.homePath, '.debrute');
  const productRoot = path.join(debruteHome, 'products');
  const current = path.join(productRoot, 'current');
  const productRuntime = input.platform === 'darwin'
    ? path.join(current, 'runtime', 'Debrute Runtime.app', 'Contents', 'MacOS', 'debrute-runtime')
    : path.join(current, 'runtime', 'debrute-runtime.exe');
  const entrypoint = input.platform === 'darwin'
    ? path.join(debruteHome, 'bin', 'debrute-runtime')
    : productRuntime;
  return {
    entrypoint,
    arguments: input.platform === 'darwin'
      ? []
      : ['--stable-runtime-entrypoint', entrypoint],
    webAssetsDirectory: path.join(current, 'web'),
    failureProbe: {
      entrypoint: productRuntime,
      productRoot
    }
  };
}
