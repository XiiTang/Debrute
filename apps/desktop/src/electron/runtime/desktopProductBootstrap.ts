import { join } from 'node:path';

export interface DesktopRuntimeLaunchConfiguration {
  entrypoint: string;
  arguments: string[];
  webAssetsDirectory: string;
}

export function desktopRuntimeLaunchConfiguration(input: {
  configuredEntrypoint?: string;
  configuredArguments: string[];
  configuredWebAssetsDirectory?: string;
  sourceWebAssetsDirectory: string;
  resourcesPath: string;
  homePath: string;
  executablePath: string;
  applicationPath: string;
  packaged: boolean;
  platform: NodeJS.Platform;
}): DesktopRuntimeLaunchConfiguration {
  if (input.configuredEntrypoint) {
    return {
      entrypoint: input.configuredEntrypoint,
      arguments: input.configuredArguments,
      webAssetsDirectory: input.configuredWebAssetsDirectory ?? input.sourceWebAssetsDirectory
    };
  }
  const runtimeExecutable = input.platform === 'win32'
    ? join('runtime', 'debrute-runtime.exe')
    : join('runtime', 'Debrute Runtime.app', 'Contents', 'MacOS', 'debrute-runtime');
  const seed = join(input.resourcesPath, 'product-seed');
  const debruteHome = join(input.homePath, '.debrute');
  return {
    entrypoint: join(seed, runtimeExecutable),
    arguments: [
      'bootstrap',
      '--seed', seed,
      '--product-root', join(debruteHome, 'products'),
      '--bin-directory', join(debruteHome, 'bin'),
      '--desktop-entrypoint', input.executablePath,
      '--desktop-arguments-json', JSON.stringify(input.packaged ? [] : [input.applicationPath])
    ],
    webAssetsDirectory: join(seed, 'web')
  };
}
