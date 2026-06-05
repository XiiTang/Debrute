import { join } from 'node:path';

export type DebruteCliPublicPlatform = 'macos' | 'linux' | 'windows';

export interface DebruteCliTargetInput {
  version: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}

export function debruteCliPlatform(platform: NodeJS.Platform = process.platform): DebruteCliPublicPlatform {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  throw new Error(`Unsupported Debrute CLI platform: ${platform}`);
}

export function debruteCliArchiveExtension(platform: NodeJS.Platform = process.platform): 'tar.gz' | 'zip' {
  return platform === 'win32' ? 'zip' : 'tar.gz';
}

export function debruteCliExecutableName(platform: NodeJS.Platform = process.platform): 'debrute' | 'debrute.exe' {
  return platform === 'win32' ? 'debrute.exe' : 'debrute';
}

export function debruteCliAssetName(input: DebruteCliTargetInput): string {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  return `debrute-cli-${input.version}-${debruteCliPlatform(platform)}-${arch}.${debruteCliArchiveExtension(platform)}`;
}

export function debruteCliReleaseUrl(input: { version: string; assetName: string }): string {
  return `https://github.com/XiiTang/Debrute/releases/download/v${input.version}/${input.assetName}`;
}

export function debruteCliChecksumUrl(version: string): string {
  return debruteCliReleaseUrl({ version, assetName: 'debrute_SHA256SUMS' });
}

export function debruteCliManagedPaths(input: { userHome: string; version: string; platform?: NodeJS.Platform }) {
  const platform = input.platform ?? process.platform;
  const installDir = join(input.userHome, '.debrute', 'cli', input.version);
  const executablePath = join(installDir, debruteCliExecutableName(platform));
  const binDir = join(input.userHome, '.debrute', 'bin');
  const shimPath = join(binDir, platform === 'win32' ? 'debrute.cmd' : 'debrute');
  const statePath = join(input.userHome, '.debrute', 'skills-state.json');
  return { installDir, executablePath, binDir, shimPath, statePath };
}

export function userPathEntry(input: { userHome: string }): string {
  return join(input.userHome, '.debrute', 'bin');
}

export function shellProfilePath(input: { userHome: string; platform?: NodeJS.Platform; shell?: string }): string {
  const platform = input.platform ?? process.platform;
  const shell = input.shell ?? process.env.SHELL ?? '';
  if (platform === 'darwin' && shell.endsWith('zsh')) return join(input.userHome, '.zprofile');
  if (platform === 'darwin' && shell.endsWith('bash')) return join(input.userHome, '.bash_profile');
  if (platform === 'linux' && shell.endsWith('zsh')) return join(input.userHome, '.zshrc');
  if (platform === 'linux' && shell.endsWith('bash')) return join(input.userHome, '.bashrc');
  return join(input.userHome, '.profile');
}
