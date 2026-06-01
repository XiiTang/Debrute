import { posix, win32 } from 'node:path';

export interface AxisCliTarget {
  id: AxisCliTargetId;
  executableName: 'axis' | 'axis.exe';
  archiveExtension: 'tar.gz' | 'zip';
}

export type AxisCliTargetId =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-x64'
  | 'windows-arm64'
  | 'windows-x64';

export interface AxisCliPaths {
  homeDir: string;
  binDir: string;
  commandPath: string;
  developmentCommandPath: string;
  installRoot: string;
  releasesDir: string;
  currentPath: string;
  lockFile: string;
  devLinkFile: string;
  target: AxisCliTarget;
  releaseDir(version: string): string;
}

export function resolveAxisCliTarget(platform: NodeJS.Platform, arch: NodeJS.Architecture): AxisCliTarget {
  if (platform === 'darwin' && arch === 'arm64') {
    return { id: 'darwin-arm64', executableName: 'axis', archiveExtension: 'tar.gz' };
  }
  if (platform === 'darwin' && arch === 'x64') {
    return { id: 'darwin-x64', executableName: 'axis', archiveExtension: 'tar.gz' };
  }
  if (platform === 'linux' && arch === 'arm64') {
    return { id: 'linux-arm64', executableName: 'axis', archiveExtension: 'tar.gz' };
  }
  if (platform === 'linux' && arch === 'x64') {
    return { id: 'linux-x64', executableName: 'axis', archiveExtension: 'tar.gz' };
  }
  if (platform === 'win32' && arch === 'arm64') {
    return { id: 'windows-arm64', executableName: 'axis.exe', archiveExtension: 'zip' };
  }
  if (platform === 'win32' && arch === 'x64') {
    return { id: 'windows-x64', executableName: 'axis.exe', archiveExtension: 'zip' };
  }
  throw new Error(`Unsupported AXIS CLI platform: ${platform}-${arch}`);
}

export function resolveAxisCliPaths(input: {
  homeDir: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
}): AxisCliPaths {
  const target = resolveAxisCliTarget(input.platform, input.arch);
  const pathApi = input.platform === 'win32' ? win32 : posix;
  const axisRoot = pathApi.join(input.homeDir, '.axis');
  const installRoot = pathApi.join(axisRoot, 'cli');
  const releasesDir = pathApi.join(installRoot, 'releases');
  return {
    homeDir: input.homeDir,
    binDir: pathApi.join(axisRoot, 'bin'),
    commandPath: pathApi.join(axisRoot, 'bin', target.executableName),
    developmentCommandPath: pathApi.join(axisRoot, 'bin', input.platform === 'win32' ? 'axis.cmd' : target.executableName),
    installRoot,
    releasesDir,
    currentPath: pathApi.join(installRoot, 'current'),
    lockFile: pathApi.join(installRoot, 'install.lock'),
    devLinkFile: pathApi.join(installRoot, 'dev-link.json'),
    target,
    releaseDir: (version) => pathApi.join(releasesDir, `${version}-${target.id}`)
  };
}

export function axisCliAssetName(version: string, target: AxisCliTarget): string {
  return `axis-cli-${version}-${target.id}.${target.archiveExtension}`;
}
