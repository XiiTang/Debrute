import { join, resolve } from 'node:path';

export interface DesktopProductRuntimeConfigInput {
  appVersion: string;
  electronDistDir: string;
  userHome: string;
  platform: NodeJS.Platform;
  execPath: string;
  appImagePath?: string;
  appIsPackaged: boolean;
  desktopPid: number;
}

export interface DesktopProductRuntimeConfig {
  productVersion: string;
  cliPayloadDir: string;
  skillsPayloadDir: string;
  managedBinDir: string;
  managedProductRoot: string;
  productManifestPath: string;
  desktopInstallPath: string;
  replacementHelperPath: string;
  desktopPid: number;
}

export function desktopProductRuntimeConfig(input: DesktopProductRuntimeConfigInput): DesktopProductRuntimeConfig {
  const productRoot = resolve(input.electronDistDir, 'runtime-product');
  return {
    productVersion: input.appVersion,
    cliPayloadDir: join(productRoot, 'cli'),
    skillsPayloadDir: join(productRoot, 'skills'),
    managedBinDir: join(input.userHome, '.debrute', 'bin'),
    managedProductRoot: join(input.userHome, '.debrute', 'products'),
    productManifestPath: join(productRoot, 'product-manifest.json'),
    desktopInstallPath: desktopInstallPath(input),
    replacementHelperPath: resolve(input.electronDistDir, 'product-replacement-helper.cjs'),
    desktopPid: input.desktopPid
  };
}

function desktopInstallPath(input: DesktopProductRuntimeConfigInput): string {
  if (input.platform === 'linux' && input.appIsPackaged) {
    if (!input.appImagePath) {
      throw new Error('APPIMAGE is required for packaged Linux Debrute updates.');
    }
    return input.appImagePath;
  }
  return input.execPath;
}
