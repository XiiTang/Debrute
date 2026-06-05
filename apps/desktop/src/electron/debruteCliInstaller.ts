import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  DebruteCliInstallResult,
  DebruteCliManualCommand,
  DebruteCliPathRepairResult,
  DebruteCliSkillsStatus,
  DebruteCliSkillsSyncResult,
  DebruteCliStatus
} from '@debrute/app-protocol';
import {
  checksumForAsset,
  extractDebruteCliArchive,
  parseSha256Manifest,
  sha256File,
  validateExtractedDebruteCliPayload
} from './debruteCliArchive.js';
import {
  debruteCliAssetName,
  debruteCliChecksumUrl,
  debruteCliExecutableName,
  debruteCliManagedPaths,
  debruteCliReleaseUrl
} from './debruteCliPaths.js';
import {
  getDebruteCliStatus,
  manualInstallCommand,
  pathRepairCommand,
  repairDebruteCliPath
} from './debruteCliStatus.js';
import { runDebruteCli, type DebruteCliRunResult } from './debruteCliProcess.js';

export interface DebruteCliInstaller {
  getStatus(): Promise<DebruteCliStatus>;
  install(): Promise<DebruteCliInstallResult>;
  update(): Promise<DebruteCliInstallResult>;
  repairPath(): Promise<DebruteCliPathRepairResult>;
  syncSkills(force?: boolean): Promise<DebruteCliSkillsSyncResult>;
  getManualInstallCommand(): Promise<DebruteCliManualCommand>;
}

export interface DebruteCliInstallerInput {
  desktopVersion: string;
  userHome: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  envPath?: string;
  shell?: string;
  fetchAsset?: (url: string, destination: string) => Promise<void>;
  extractArchive?: (input: { archivePath: string; destinationDir: string; platform: NodeJS.Platform }) => Promise<void>;
  repairPath?: () => Promise<void>;
  runDebrute?: (debrutePath: string, args: string[]) => Promise<DebruteCliRunResult>;
}

export function createDebruteCliInstaller(input: DebruteCliInstallerInput): DebruteCliInstaller {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const runDebrute = input.runDebrute ?? runDebruteCli;
  const manual = () => manualInstallCommand({ version: input.desktopVersion, platform, arch });
  const managedPaths = () => debruteCliManagedPaths({ userHome: input.userHome, version: input.desktopVersion, platform });
  const repairInput = () => ({
    userHome: input.userHome,
    platform,
    ...(input.shell ? { shell: input.shell } : {})
  });

  const getStatusForEnvPath = (envPath?: string) => getDebruteCliStatus({
    desktopVersion: input.desktopVersion,
    userHome: input.userHome,
    platform,
    arch,
    runDebrute,
    ...(envPath !== undefined ? { envPath } : {}),
    ...(input.shell ? { shell: input.shell } : {})
  });
  const getStatus = () => getStatusForEnvPath(input.envPath);

  async function install(): Promise<DebruteCliInstallResult> {
    const assetName = debruteCliAssetName({ version: input.desktopVersion, platform, arch });
    const tempRoot = join(tmpdir(), `debrute-cli-${process.pid}-${Date.now()}`);
    const archivePath = join(tempRoot, assetName);
    const checksumPath = join(tempRoot, 'debrute_SHA256SUMS');
    const paths = managedPaths();
    const stagedInstallDir = join(dirname(paths.installDir), `.${input.desktopVersion}.${process.pid}.${randomUUID()}.install`);
    try {
      await mkdir(tempRoot, { recursive: true });
      const fetchAsset = input.fetchAsset ?? downloadFile;
      await fetchAsset(debruteCliReleaseUrl({ version: input.desktopVersion, assetName }), archivePath);
      await fetchAsset(debruteCliChecksumUrl(input.desktopVersion), checksumPath);
      const expectedChecksum = checksumForAsset(parseSha256Manifest(await readFile(checksumPath, 'utf8')), assetName);
      const actualChecksum = await sha256File(archivePath);
      if (actualChecksum !== expectedChecksum) {
        throw new Error(`Checksum mismatch for ${assetName}.`);
      }

      await rm(stagedInstallDir, { recursive: true, force: true });
      await mkdir(stagedInstallDir, { recursive: true });
      await (input.extractArchive ?? extractDebruteCliArchive)({ archivePath, destinationDir: stagedInstallDir, platform });
      await validateExtractedDebruteCliPayload({ root: stagedInstallDir, executableName: debruteCliExecutableName(platform) });

      const stagedExecutablePath = join(stagedInstallDir, debruteCliExecutableName(platform));
      const versionResult = await runDebrute(stagedExecutablePath, ['--version']);
      if (versionResult.exitCode !== 0 || parseDebruteVersion(versionResult.stdout) !== input.desktopVersion) {
        throw new Error(`Debrute CLI version verification failed: ${versionResult.stderr || versionResult.stdout}`);
      }

      await mkdir(dirname(paths.installDir), { recursive: true });
      await rm(paths.installDir, { recursive: true, force: true });
      await rename(stagedInstallDir, paths.installDir);
      await activateShim(paths, platform);

      let pathRepairFailed = false;
      try {
        await (input.repairPath ?? (() => repairDebruteCliPath(repairInput())))();
      } catch {
        pathRepairFailed = true;
      }

      const skillsResult = await runDebrute(paths.shimPath, ['skills', 'sync']);
      const status = await getStatusForEnvPath(pathRepairFailed
        ? input.envPath
        : envPathWithManagedBin(paths.binDir, input.envPath ?? process.env.PATH ?? '', platform));
      const statusWithSkills = skillsResult.exitCode === 0
        ? status
        : withSkillsStatus(status, { kind: 'error', code: 'skills_sync_failed', message: skillsResult.stderr || 'Debrute Skills sync failed.' });

      const skills = skillsStatusFromCliStatus(statusWithSkills);
      if (pathRepairFailed && 'cliVersion' in statusWithSkills && skills) {
        return {
          ok: true,
          status: {
            kind: 'installed_but_not_on_path',
            desktopVersion: input.desktopVersion,
            cliVersion: statusWithSkills.cliVersion,
            managedPath: paths.shimPath,
            repairCommand: pathRepairCommand({ userHome: input.userHome, platform }),
            skills
          }
        };
      }
      return { ok: true, status: statusWithSkills };
    } catch (error) {
      return {
        ok: false,
        status: {
          kind: 'error',
          desktopVersion: input.desktopVersion,
          code: 'debrute_cli_install_failed',
          message: error instanceof Error ? error.message : String(error),
          manualCommand: manual().command
        }
      };
    } finally {
      await rm(stagedInstallDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    getStatus,
    install,
    update: install,
    repairPath: async () => {
      const paths = managedPaths();
      await (input.repairPath ?? (() => repairDebruteCliPath(repairInput())))();
      return { ok: true, status: await getStatusForEnvPath(envPathWithManagedBin(paths.binDir, input.envPath ?? process.env.PATH ?? '', platform)) };
    },
    syncSkills: async (force = false) => {
      const paths = managedPaths();
      const result = await runDebrute(paths.shimPath, ['skills', 'sync', ...(force ? ['--force'] : [])]);
      if (result.exitCode !== 0) {
        return { ok: false, status: { kind: 'error', code: 'skills_sync_failed', message: result.stderr || 'Debrute Skills sync failed.' } };
      }
      const skills = skillsStatusFromCliStatus(await getStatus());
      if (!skills) {
        return {
          ok: false,
          status: {
            kind: 'error',
            code: 'debrute_cli_status_unavailable',
            message: 'Debrute CLI status does not include Skills state.'
          }
        };
      }
      return { ok: true, status: skills };
    },
    getManualInstallCommand: async () => manual()
  };
}

async function activateShim(
  paths: ReturnType<typeof debruteCliManagedPaths>,
  platform: NodeJS.Platform
): Promise<void> {
  await mkdir(paths.binDir, { recursive: true });
  await rm(paths.shimPath, { force: true });
  if (platform === 'win32') {
    await writeFile(paths.shimPath, `@echo off\r\n"${paths.executablePath}" %*\r\n`, 'utf8');
    return;
  }
  await symlink(paths.executablePath, paths.shimPath);
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

function parseDebruteVersion(stdout: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
}

function skillsStatusFromCliStatus(status: DebruteCliStatus): DebruteCliSkillsStatus | undefined {
  return 'skills' in status ? status.skills : undefined;
}

function withSkillsStatus(status: DebruteCliStatus, skills: DebruteCliSkillsStatus): DebruteCliStatus {
  if (!('skills' in status)) return status;
  return { ...status, skills };
}

function envPathWithManagedBin(binDir: string, envPath: string, platform: NodeJS.Platform): string {
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const entries = envPath.split(pathDelimiter).filter(Boolean);
  const nextEntries = [
    binDir,
    ...entries.filter((entry) => !samePathEntry(entry, binDir, platform))
  ];
  return nextEntries.join(pathDelimiter);
}

function samePathEntry(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
