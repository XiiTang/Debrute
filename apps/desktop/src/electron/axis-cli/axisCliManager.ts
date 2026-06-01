import { randomUUID } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { delimiter, dirname, join, normalize, win32 } from 'node:path';
import { promisify } from 'node:util';
import type {
  AxisCliDiagnostic,
  AxisCliDiagnosticCode,
  AxisCliOperationKind,
  AxisCliOperationState,
  AxisCliPathState,
  AxisCliStatus
} from '@axis/app-protocol';
import { isAxisCliDiagnosticCode } from '@axis/app-protocol';
import { extractAxisCliArchive, ensureAxisCliExecutable } from './axisCliArchive.js';
import { createAxisCliDevelopmentLauncher } from './axisCliLauncher.js';
import {
  createWindowsUserPathStore,
  ensureWindowsAxisCliPath,
  ensurePosixAxisCliPath,
  readPosixPathState,
  readWindowsPathState,
  removeWindowsAxisCliPath,
  removePosixAxisCliPath,
  selectPosixProfilePath,
  type WindowsUserPathStore
} from './axisCliPathProfiles.js';
import { resolveAxisCliPaths, type AxisCliPaths } from './axisCliPaths.js';
import { createGitHubAxisCliReleaseClient, type AxisCliReleaseClient } from './axisCliReleaseClient.js';

const execFileAsync = promisify(execFile);
const SKILLS_SYNC_TIMEOUT_MS = 30_000;
const DIAGNOSTIC_OUTPUT_LIMIT = 2_000;

export interface AxisCliManager {
  getStatus(): Promise<AxisCliStatus>;
  install(): Promise<AxisCliStatus>;
  update(): Promise<AxisCliStatus>;
  repair(): Promise<AxisCliStatus>;
  uninstall(): Promise<AxisCliStatus>;
  refreshDevelopmentLink(): Promise<AxisCliStatus>;
}

export interface AxisCliManagerInput {
  appVersion: string;
  arch?: NodeJS.Architecture;
  env?: NodeJS.ProcessEnv;
  homeDir: string;
  nodePath?: string;
  onStatusChange?: (status: AxisCliStatus) => void;
  packaged: boolean;
  platform?: NodeJS.Platform;
  releaseClient?: AxisCliReleaseClient;
  repoRoot?: string;
  windowsUserPath?: WindowsUserPathStore;
}

interface AxisCliDevLink {
  mode: 'source-linked';
  repoRoot: string;
  entrypoint: string;
  tsxEntrypoint: string;
}

export function createAxisCliManager(input: AxisCliManagerInput): AxisCliManager {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const env = input.env ?? process.env;
  const paths = resolveAxisCliPaths({ homeDir: input.homeDir, platform, arch });
  const commandPath = input.packaged ? paths.commandPath : paths.developmentCommandPath;
  const commandName = platform === 'win32' && !input.packaged ? 'axis.cmd' : paths.target.executableName;
  const releaseClient = input.releaseClient ?? createGitHubAxisCliReleaseClient();
  const windowsUserPath = platform === 'win32'
    ? input.windowsUserPath ?? createWindowsUserPathStore()
    : undefined;
  let currentOperation: AxisCliOperationState | undefined;
  let lastDiagnostic: AxisCliDiagnostic | undefined;

  const getStatus = async (diagnostic = lastDiagnostic): Promise<AxisCliStatus> => {
    const [commandExists, devLink, latestResult, resolvedPath, pathState] = await Promise.all([
      pathEntryExists(commandPath),
      readDevLink(paths.devLinkFile),
      readLatestVersion(releaseClient),
      findCommandOnPath(commandName, env.PATH ?? env.Path ?? '', platform),
      readPathState(paths, env, platform, windowsUserPath)
    ]);
    const installedVersion = commandExists
      ? await readInstalledVersion(paths, devLink, input.appVersion)
      : undefined;
    const statusDiagnostic = commandExists
      ? devLink
        ? await validateDevelopmentLink(devLink)
        : await validateReleaseCommand(paths, installedVersion)
      : undefined;
    const mode = commandExists
      ? statusDiagnostic ? 'broken' : devLink ? 'source-linked' : 'release'
      : 'missing';
    const conflict = resolvedPath && !samePath(resolvedPath, commandPath)
      ? {
          managedPath: commandPath,
          resolvedPath,
          message: 'Another axis command resolves before AXIS.'
        }
      : undefined;
    const status: AxisCliStatus = {
      mode,
      managed: commandExists && !conflict,
      ...(installedVersion ? { installedVersion } : {}),
      ...(latestResult.version ? { latestVersion: latestResult.version } : {}),
      updateAvailable: Boolean(installedVersion && latestResult.version && installedVersion !== latestResult.version),
      commandPath,
      ...(resolvedPath ? { resolvedPath } : {}),
      binDir: paths.binDir,
      installRoot: paths.installRoot,
      pathState,
      ...(conflict ? { conflict } : {}),
      ...(currentOperation ? { operation: currentOperation } : {}),
      ...(diagnostic ?? statusDiagnostic ?? latestResult.diagnostic ? { diagnostic: diagnostic ?? statusDiagnostic ?? latestResult.diagnostic } : {})
    };
    return status;
  };

  const runOperation = async (
    kind: AxisCliOperationKind,
    operation: () => Promise<AxisCliDiagnostic | undefined>
  ): Promise<AxisCliStatus> => {
    if (currentOperation) {
      lastDiagnostic = {
        operation: kind,
        code: 'operation_already_running',
        message: 'Another AXIS CLI operation is already running.'
      };
      const status = await getStatus(lastDiagnostic);
      input.onStatusChange?.(status);
      return status;
    }
    currentOperation = { kind, running: true, startedAt: new Date().toISOString() };
    input.onStatusChange?.(await getStatus(undefined));
    try {
      lastDiagnostic = await withOperationLock(paths, kind, operation);
      if (lastDiagnostic && !lastDiagnostic.operation) {
        lastDiagnostic = { ...lastDiagnostic, operation: kind };
      }
    } catch (error) {
      lastDiagnostic = diagnosticFromError(kind, error);
    } finally {
      currentOperation = undefined;
    }
    const status = await getStatus(lastDiagnostic);
    input.onStatusChange?.(status);
    return status;
  };

  return {
    getStatus,
    install: () => runOperation('install', () => input.packaged ? installRelease(paths, env, platform, releaseClient, windowsUserPath, true) : writeDevelopmentLink()),
    update: () => runOperation('update', () => input.packaged ? installRelease(paths, env, platform, releaseClient, windowsUserPath, false) : writeDevelopmentLink()),
    repair: () => runOperation('repair', async () => {
      if (!input.packaged) {
        return writeDevelopmentLink();
      }
      const status = await getStatus(undefined);
      if (status.mode !== 'release') {
        return installRelease(paths, env, platform, releaseClient, windowsUserPath, true);
      }
      const pathDiagnostic = await ensureManagedPath(paths, env, platform, windowsUserPath);
      if (pathDiagnostic) {
        return pathDiagnostic;
      }
      await probeAxisVersion(paths.commandPath);
      return syncSkillsWithActiveCli(paths.commandPath, true);
    }),
    uninstall: () => runOperation('uninstall', () => uninstallManagedCli(paths, env, platform, windowsUserPath)),
    refreshDevelopmentLink: () => runOperation('refresh-development-link', writeDevelopmentLink)
  };

  async function writeDevelopmentLink(): Promise<AxisCliDiagnostic | undefined> {
    if (!input.repoRoot) {
      return {
        operation: 'refresh-development-link',
        code: 'source_checkout_missing',
        message: 'AXIS repository root is unavailable.'
      };
    }
    const diagnostic = await createAxisCliDevelopmentLauncher({
      commandPath,
      devLinkFile: paths.devLinkFile,
      platform,
      repoRoot: input.repoRoot,
      nodePath: input.nodePath ?? process.execPath
    });
    if (diagnostic) {
      return diagnostic;
    }
    const pathDiagnostic = await ensureManagedPath(paths, env, platform, windowsUserPath);
    if (pathDiagnostic) {
      return pathDiagnostic;
    }
    await probeAxisVersion(commandPath);
    return syncSkillsWithActiveCli(commandPath, true);
  }
}

async function installRelease(
  paths: AxisCliPaths,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  releaseClient: AxisCliReleaseClient,
  windowsUserPath: WindowsUserPathStore | undefined,
  syncForce: boolean
): Promise<AxisCliDiagnostic | undefined> {
  await mkdir(paths.installRoot, { recursive: true });
  await mkdir(paths.releasesDir, { recursive: true });
  await mkdir(paths.binDir, { recursive: true });
  const operationId = randomUUID();
  const stagingRoot = join(paths.installRoot, `staging-${operationId}`);
  const stagingArchivePath = join(paths.installRoot, `download-${operationId}.${paths.target.archiveExtension}`);
  try {
    const release = await releaseClient.installLatest({
      target: paths.target,
      stagingArchivePath,
      writeArchive: (path, data) => writeFile(path, data)
    });
    await mkdir(stagingRoot, { recursive: true });
    await extractAxisCliArchive({
      archivePath: release.archivePath,
      destinationDir: stagingRoot,
      target: paths.target
    });
    const stagedBinary = join(stagingRoot, paths.target.executableName);
    if (!await fileExists(stagedBinary)) {
      throw Object.assign(new Error('AXIS CLI binary is missing from the release archive.'), {
        code: 'binary_missing',
        path: stagedBinary
      });
    }
    await ensureAxisCliExecutable(stagedBinary, platform);
    await probeAxisVersion(stagedBinary);
    await writeFile(join(stagingRoot, 'package.json'), `${JSON.stringify({ version: release.version }, null, 2)}\n`, 'utf8');

    const releaseDir = paths.releaseDir(release.version);
    await rm(releaseDir, { recursive: true, force: true });
    await renameReplace(stagingRoot, releaseDir);
    await activateRelease(paths, releaseDir, platform, operationId);
    if (!samePath(paths.developmentCommandPath, paths.commandPath)) {
      await rm(paths.developmentCommandPath, { force: true });
    }
    await rm(paths.devLinkFile, { force: true });
    const pathDiagnostic = await ensureManagedPath(paths, env, platform, windowsUserPath);
    if (pathDiagnostic) {
      return pathDiagnostic;
    }
    await probeAxisVersion(paths.commandPath);
    return syncSkillsWithActiveCli(paths.commandPath, syncForce);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(stagingArchivePath, { force: true });
  }
}

async function uninstallManagedCli(
  paths: AxisCliPaths,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  windowsUserPath: WindowsUserPathStore | undefined
): Promise<AxisCliDiagnostic | undefined> {
  await rm(paths.commandPath, { force: true });
  if (!samePath(paths.developmentCommandPath, paths.commandPath)) {
    await rm(paths.developmentCommandPath, { force: true });
  }
  await rm(paths.installRoot, { recursive: true, force: true });
  if (platform === 'win32') {
    if (!windowsUserPath) {
      return windowsPathDiagnostic(new Error('Windows user PATH store is unavailable.'));
    }
    try {
      await removeWindowsAxisCliPath(windowsUserPath, paths.binDir);
      env.Path = await windowsUserPath.read();
    } catch (error) {
      return windowsPathDiagnostic(error);
    }
    return undefined;
  }
  await removePosixAxisCliPath(selectPosixProfilePath({
    homeDir: paths.homeDir,
    platform,
    shell: env.SHELL
  }));
  return undefined;
}

async function ensureManagedPath(
  paths: AxisCliPaths,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  windowsUserPath: WindowsUserPathStore | undefined
): Promise<AxisCliDiagnostic | undefined> {
  if (platform === 'win32') {
    if (!windowsUserPath) {
      return windowsPathDiagnostic(new Error('Windows user PATH store is unavailable.'));
    }
    try {
      await ensureWindowsAxisCliPath(windowsUserPath, paths.binDir);
      env.Path = await windowsUserPath.read();
    } catch (error) {
      return windowsPathDiagnostic(error);
    }
    return undefined;
  }
  try {
    await ensurePosixAxisCliPath({
      profilePath: selectPosixProfilePath({ homeDir: paths.homeDir, platform, shell: env.SHELL }),
      binDir: paths.binDir
    });
    return undefined;
  } catch (error) {
    return {
      code: 'path_profile_unwritable',
      path: selectPosixProfilePath({ homeDir: paths.homeDir, platform, shell: env.SHELL }),
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readPathState(
  paths: AxisCliPaths,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  windowsUserPath: WindowsUserPathStore | undefined
): Promise<AxisCliPathState> {
  if (platform === 'win32') {
    return windowsUserPath ? readWindowsPathState(windowsUserPath, paths.binDir) : 'not-configured';
  }
  return readPosixPathState({
    profilePath: selectPosixProfilePath({ homeDir: paths.homeDir, platform, shell: env.SHELL }),
    binDir: paths.binDir,
    envPath: env.PATH,
    pathDelimiter: delimiter
  });
}

async function readLatestVersion(releaseClient: AxisCliReleaseClient): Promise<{
  version?: string;
  diagnostic?: AxisCliDiagnostic;
}> {
  try {
    const version = await releaseClient.getLatestVersion();
    return version ? { version } : {};
  } catch (error) {
    return { diagnostic: diagnosticFromError(undefined, error) };
  }
}

async function validateDevelopmentLink(devLink: AxisCliDevLink): Promise<AxisCliDiagnostic | undefined> {
  if (!await fileExists(devLink.entrypoint)) {
    return {
      code: 'source_checkout_missing',
      path: devLink.entrypoint,
      message: 'AXIS CLI source checkout is missing.'
    };
  }
  if (!await fileExists(devLink.tsxEntrypoint)) {
    return {
      code: 'source_dependency_missing',
      path: devLink.tsxEntrypoint,
      message: 'AXIS CLI development dependencies are missing.'
    };
  }
  return undefined;
}

async function validateReleaseCommand(paths: AxisCliPaths, installedVersion: string | undefined): Promise<AxisCliDiagnostic | undefined> {
  if (!installedVersion) {
    return {
      code: 'binary_missing',
      path: join(paths.currentPath, 'package.json'),
      message: 'AXIS CLI release metadata is missing.'
    };
  }
  try {
    await probeAxisVersion(paths.commandPath);
    return undefined;
  } catch (error) {
    return diagnosticFromError(undefined, error);
  }
}

async function readInstalledVersion(paths: AxisCliPaths, devLink: AxisCliDevLink | undefined, appVersion: string): Promise<string | undefined> {
  if (devLink) {
    return appVersion;
  }
  return readPackageVersion(join(paths.currentPath, 'package.json'));
}

async function readPackageVersion(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function readDevLink(path: string): Promise<AxisCliDevLink | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isAxisCliDevLink(parsed) ? parsed : undefined;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function findCommandOnPath(commandName: string, pathValue: string, platform: NodeJS.Platform): Promise<string | undefined> {
  for (const entry of pathValue.split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    const candidate = platform === 'win32' ? win32.join(entry, commandName) : join(entry, commandName);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function probeAxisVersion(commandPath: string): Promise<void> {
  try {
    await execFileAsync(commandPath, ['--version'], { timeout: 5000 });
  } catch (error) {
    throw Object.assign(new Error('AXIS CLI version probe failed.'), {
      code: 'version_probe_failed',
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function syncSkillsWithActiveCli(commandPath: string, force: boolean): Promise<AxisCliDiagnostic | undefined> {
  const args = ['skills', 'sync', ...(force ? ['--force'] : [])];
  try {
    const output = await execFileAsync(commandPath, args, {
      timeout: SKILLS_SYNC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    });
    const stdout = outputText(output.stdout);
    const stderr = outputText(output.stderr);
    if (stdout.trimStart().startsWith('axis/1 error')) {
      return skillsSyncDiagnostic(args, [stdout, stderr].join('\n'));
    }
    return undefined;
  } catch (error) {
    return skillsSyncDiagnostic(args, diagnosticErrorOutput(error));
  }
}

function skillsSyncDiagnostic(args: string[], output: string | undefined): AxisCliDiagnostic {
  const summary = boundedOutput(output);
  return {
    code: 'skills_sync_failed',
    message: summary
      ? `AXIS CLI is active, but "axis ${args.join(' ')}" failed: ${summary}`
      : `AXIS CLI is active, but "axis ${args.join(' ')}" failed.`
  };
}

function diagnosticErrorOutput(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  return [
    error.message,
    outputText((error as Error & { stdout?: unknown }).stdout),
    outputText((error as Error & { stderr?: unknown }).stderr)
  ].filter(Boolean).join('\n');
}

function outputText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return '';
}

function boundedOutput(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > DIAGNOSTIC_OUTPUT_LIMIT
    ? trimmed.slice(0, DIAGNOSTIC_OUTPUT_LIMIT)
    : trimmed;
}

async function activateRelease(
  paths: AxisCliPaths,
  releaseDir: string,
  platform: NodeJS.Platform,
  operationId: string
): Promise<void> {
  if (platform === 'win32') {
    const currentTemp = `${paths.currentPath}.${operationId}.tmp`;
    const commandTemp = `${paths.commandPath}.${operationId}.tmp`;
    await rm(currentTemp, { recursive: true, force: true });
    await cp(releaseDir, currentTemp, { recursive: true });
    await copyFile(join(currentTemp, paths.target.executableName), commandTemp);
    await rm(paths.currentPath, { recursive: true, force: true });
    await rename(currentTemp, paths.currentPath);
    await rename(commandTemp, paths.commandPath);
    return;
  }

  const currentTemp = `${paths.currentPath}.${operationId}.tmp`;
  const commandTemp = `${paths.commandPath}.${operationId}.tmp`;
  await rm(currentTemp, { force: true });
  await rm(commandTemp, { force: true });
  await symlink(releaseDir, currentTemp, 'dir');
  await symlink(join(paths.currentPath, paths.target.executableName), commandTemp);
  await rename(currentTemp, paths.currentPath);
  await rename(commandTemp, paths.commandPath);
}

async function renameReplace(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

async function withOperationLock(
  paths: AxisCliPaths,
  kind: AxisCliOperationKind,
  operation: () => Promise<AxisCliDiagnostic | undefined>
): Promise<AxisCliDiagnostic | undefined> {
  await mkdir(paths.installRoot, { recursive: true });
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lockHandle = await open(paths.lockFile, 'wx');
    await lockHandle.writeFile(`${JSON.stringify({
      operation: kind,
      startedAt: new Date().toISOString()
    }, null, 2)}\n`, 'utf8');
    return await operation();
  } catch (error) {
    if (isNodeErrorCode(error, 'EEXIST')) {
      return {
        operation: kind,
        code: 'operation_already_running',
        message: 'Another AXIS CLI operation is already running.'
      };
    }
    throw error;
  } finally {
    if (lockHandle) {
      await lockHandle.close();
      await rm(paths.lockFile, { force: true });
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function windowsPathDiagnostic(error: unknown): AxisCliDiagnostic {
  return {
    code: 'windows_path_update_failed',
    message: error instanceof Error ? error.message : String(error)
  };
}

function diagnosticFromError(operation: AxisCliOperationKind | undefined, error: unknown): AxisCliDiagnostic {
  const code = errorCode(error);
  const path = typeof error === 'object' && error !== null && 'path' in error && typeof error.path === 'string'
    ? error.path
    : undefined;
  return {
    ...(operation ? { operation } : {}),
    code,
    ...(path ? { path } : {}),
    message: error instanceof Error ? error.message : String(error)
  };
}

function errorCode(error: unknown): AxisCliDiagnosticCode {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    const code = error.code;
    if (code === 'EACCES' || code === 'EPERM') {
      return 'install_root_unwritable';
    }
    if (isAxisCliDiagnosticCode(code)) {
      return code;
    }
  }
  return 'internal_error';
}

function samePath(left: string, right: string): boolean {
  return normalize(left).toLowerCase() === normalize(right).toLowerCase();
}

function isAxisCliDevLink(value: unknown): value is AxisCliDevLink {
  return typeof value === 'object'
    && value !== null
    && 'mode' in value
    && value.mode === 'source-linked'
    && 'repoRoot' in value
    && typeof value.repoRoot === 'string'
    && 'entrypoint' in value
    && typeof value.entrypoint === 'string'
    && 'tsxEntrypoint' in value
    && typeof value.tsxEntrypoint === 'string';
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}
