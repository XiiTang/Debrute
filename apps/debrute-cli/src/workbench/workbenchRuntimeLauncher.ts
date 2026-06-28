import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cliError, isDebruteCliError, messageFromUnknown } from '../errors/cliErrors.js';
import { packagedExecutablePath } from '../runtime/packagedNodeModules.js';
import { INTERNAL_WORKBENCH_RUNTIME_CHILD_COMMAND } from './workbenchRuntimeChildEntrypoint.js';
import {
  DEFAULT_WORKBENCH_DAEMON_PORT,
  DEFAULT_WORKBENCH_WEB_PORT,
  chooseLoopbackPort,
  ensureRegisteredWorkbenchRuntime,
  isWorkbenchRuntimeOwnedBy,
  isWorkbenchRuntimeHealthy,
  isWorkbenchRuntimeRegistryError,
  resolveWorkbenchRuntimePaths,
  terminateOwnedWorkbenchRuntime,
  type EnsureRegisteredWorkbenchRuntimeResult,
  type WorkbenchRuntimeOwner,
  type WorkbenchRuntimePaths,
  type WorkbenchRuntimeState
} from '@debrute/workbench-runtime';
import { resolveCliRuntimeOwner } from './cliRuntimeOwner.js';

export {
  DEFAULT_WORKBENCH_DAEMON_PORT,
  DEFAULT_WORKBENCH_WEB_PORT,
  chooseLoopbackPort,
  type WorkbenchRuntimeKind,
  type WorkbenchRuntimeState
} from '@debrute/workbench-runtime';

export type EnsureWorkbenchRuntimeResult = EnsureRegisteredWorkbenchRuntimeResult;

export interface EnsureWorkbenchRuntimeServices {
  paths?: WorkbenchRuntimePaths;
  isHealthy?: (state: WorkbenchRuntimeState) => Promise<boolean>;
  launch?: (paths: WorkbenchRuntimePaths) => Promise<WorkbenchRuntimeState>;
}

export async function ensureWorkbenchRuntime(
  services: EnsureWorkbenchRuntimeServices = {}
): Promise<EnsureWorkbenchRuntimeResult> {
  try {
    const paths = services.paths ?? resolveWorkbenchRuntimePaths();
    const owner = await resolveCliRuntimeOwner(paths.runtimeDir);
    return await ensureRegisteredWorkbenchRuntime({
      paths,
      isHealthy: services.isHealthy ?? isWorkbenchRuntimeHealthy,
      launch: services.launch ?? ((launchPaths) => launchWorkbenchRuntime(launchPaths, owner)),
      shouldTerminateStaleRuntime: (state) => isWorkbenchRuntimeOwnedBy(state, owner),
      onRuntimeLaunchFailed: (state) => terminateOwnedWorkbenchRuntime(state, owner)
    });
  } catch (error) {
    if (isDebruteCliError(error)) {
      throw error;
    }
    if (isWorkbenchRuntimeRegistryError(error)) {
      throw cliError(error.code, error.message);
    }
    throw cliError('runtime_launch_failed', messageFromUnknown(error));
  }
}

async function launchWorkbenchRuntime(
  paths: WorkbenchRuntimePaths,
  owner: WorkbenchRuntimeOwner
): Promise<WorkbenchRuntimeState> {
  const sourceRoot = await resolveSourceCheckoutRoot(resolveWorkbenchRuntimeEntryDir());
  return sourceRoot
    ? launchSourceDevRuntime(sourceRoot, paths, owner)
    : launchPackagedRuntime(paths, owner);
}

async function launchSourceDevRuntime(
  sourceRoot: string,
  paths: WorkbenchRuntimePaths,
  owner: WorkbenchRuntimeOwner
): Promise<WorkbenchRuntimeState> {
  const daemonPort = await chooseLoopbackPort(DEFAULT_WORKBENCH_DAEMON_PORT);
  const webPort = await chooseLoopbackPort(DEFAULT_WORKBENCH_WEB_PORT, new Set([daemonPort]));
  const token = randomUUID();
  await writeRuntimeTokenFile(paths, token);
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const now = new Date().toISOString();
  const daemonCommand = packageManagerCommand(sourceRoot, [
    '--filter',
    '@debrute/daemon',
    'dev',
    '--port',
    String(daemonPort),
    '--token-file',
    paths.tokenPath,
    '--web-base-url',
    webUrl
  ]);
  const daemon = spawnDetached(daemonCommand.command, daemonCommand.args, sourceRoot, paths.daemonLogPath, {
    DEBRUTE_DAEMON_PORT: String(daemonPort),
    DEBRUTE_DAEMON_TOKEN_FILE: paths.tokenPath,
    DEBRUTE_WEB_BASE_URL: webUrl,
    ...sourceDevProductEnv(sourceRoot)
  });
  const webCommand = packageManagerCommand(sourceRoot, [
    '--filter',
    '@debrute/web',
    'dev',
    '--host',
    '127.0.0.1',
    '--port',
    String(webPort),
    '--strictPort'
  ]);
  const web = spawnDetached(webCommand.command, webCommand.args, sourceRoot, paths.webLogPath, {
    DEBRUTE_DAEMON_URL: daemonUrl
  });
  const daemonPid = requirePid(daemon, 'daemon');
  const webPid = requirePid(web, 'web');

  return {
    runtimeKind: 'source-dev',
    processControl: 'managed',
    owner: {
      ...owner,
      pid: daemonPid
    },
    daemonUrl,
    webUrl,
    token,
    daemonPid,
    webPid,
    daemonLogPath: paths.daemonLogPath,
    webLogPath: paths.webLogPath,
    startedAt: now,
    updatedAt: now
  };
}

async function launchPackagedRuntime(
  paths: WorkbenchRuntimePaths,
  owner: WorkbenchRuntimeOwner
): Promise<WorkbenchRuntimeState> {
  const executablePath = packagedExecutablePath();
  const productConfig = packagedCliProductRuntimeConfig(executablePath);
  const daemonPort = await chooseLoopbackPort(DEFAULT_WORKBENCH_DAEMON_PORT);
  const token = randomUUID();
  await writeRuntimeTokenFile(paths, token);
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const now = new Date().toISOString();
  const daemon = spawnDetached(executablePath, [
    INTERNAL_WORKBENCH_RUNTIME_CHILD_COMMAND
  ], process.cwd(), paths.daemonLogPath, {
    DEBRUTE_RUNTIME_HOST_DAEMON_PORT: String(daemonPort),
    DEBRUTE_RUNTIME_HOST_TOKEN_FILE: paths.tokenPath,
    DEBRUTE_RUNTIME_HOST_WEB_DIST_DIR: productConfig.webDistDir,
    DEBRUTE_RUNTIME_HOST_PRODUCT_VERSION: productConfig.productVersion,
    DEBRUTE_RUNTIME_HOST_CLI_PAYLOAD_DIR: productConfig.cliPayloadDir,
    DEBRUTE_RUNTIME_HOST_SKILLS_PAYLOAD_DIR: productConfig.skillsPayloadDir,
    DEBRUTE_RUNTIME_HOST_MANAGED_BIN_DIR: productConfig.managedBinDir,
    DEBRUTE_RUNTIME_HOST_MANAGED_PRODUCT_ROOT: productConfig.managedProductRoot,
    DEBRUTE_RUNTIME_HOST_PRODUCT_MANIFEST_PATH: productConfig.productManifestPath,
    DEBRUTE_RUNTIME_HOST_DESKTOP_INSTALL_PATH: productConfig.desktopInstallPath,
    DEBRUTE_RUNTIME_HOST_REPLACEMENT_HELPER_PATH: productConfig.replacementHelperPath,
    PKG_EXECPATH: ''
  });
  const daemonPid = requirePid(daemon, 'daemon');

  return {
    runtimeKind: 'packaged',
    processControl: 'managed',
    owner: {
      ...owner,
      pid: daemonPid
    },
    daemonUrl,
    webUrl: daemonUrl,
    token,
    daemonPid,
    daemonLogPath: paths.daemonLogPath,
    webLogPath: paths.webLogPath,
    startedAt: now,
    updatedAt: now
  };
}

interface PackagedCliProductRuntimeConfig {
  productVersion: string;
  cliPayloadDir: string;
  skillsPayloadDir: string;
  managedBinDir: string;
  managedProductRoot: string;
  productManifestPath: string;
  webDistDir: string;
  desktopInstallPath: string;
  replacementHelperPath: string;
}

function packagedCliProductRuntimeConfig(executablePath: string): PackagedCliProductRuntimeConfig {
  const cliPayloadDir = dirname(executablePath);
  const versionRoot = dirname(cliPayloadDir);
  const managedProductRoot = dirname(versionRoot);
  const managedHome = dirname(managedProductRoot);
  const productRuntimePath = resolve(managedProductRoot, 'product-runtime.json');
  const productRuntime = readProductRuntimeConfig(productRuntimePath);
  return {
    productVersion: productRuntime.productVersion,
    cliPayloadDir,
    skillsPayloadDir: resolve(versionRoot, 'skills'),
    managedBinDir: resolve(managedHome, 'bin'),
    managedProductRoot,
    productManifestPath: resolve(managedProductRoot, 'product-manifest.json'),
    webDistDir: productRuntime.webDistDir,
    desktopInstallPath: productRuntime.desktopInstallPath,
    replacementHelperPath: productRuntime.replacementHelperPath
  };
}

function readProductRuntimeConfig(path: string): {
  productVersion: string;
  webDistDir: string;
  desktopInstallPath: string;
  replacementHelperPath: string;
} {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(parsed)
    || typeof parsed.productVersion !== 'string'
    || typeof parsed.webDistDir !== 'string'
    || typeof parsed.desktopInstallPath !== 'string'
    || typeof parsed.replacementHelperPath !== 'string') {
    throw cliError('runtime_launch_failed', `Invalid Debrute product runtime config: ${path}.`);
  }
  return {
    productVersion: parsed.productVersion,
    webDistDir: parsed.webDistDir,
    desktopInstallPath: parsed.desktopInstallPath,
    replacementHelperPath: parsed.replacementHelperPath
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sourceDevProductEnv(sourceRoot: string): Record<string, string> {
  return {
    DEBRUTE_DAEMON_PRODUCT_VERSION: readRootProductVersion(sourceRoot),
    DEBRUTE_DAEMON_CLI_PATH: resolve(sourceRoot, 'apps/debrute-cli/src/index.ts'),
    DEBRUTE_DAEMON_SKILLS_PAYLOAD_DIR: resolve(sourceRoot, 'skills')
  };
}

function readRootProductVersion(sourceRoot: string): string {
  const parsed = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8')) as unknown;
  if (!isRecord(parsed) || typeof parsed.version !== 'string' || parsed.version.trim() === '') {
    throw cliError('runtime_launch_failed', `Invalid Debrute root package version: ${resolve(sourceRoot, 'package.json')}.`);
  }
  return parsed.version;
}

async function writeRuntimeTokenFile(paths: WorkbenchRuntimePaths, token: string): Promise<void> {
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await writeFile(paths.tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
}

function spawnDetached(
  command: string,
  args: string[],
  cwd: string,
  logPath: string,
  env: Record<string, string>
): ChildProcess {
  const logFd = openSync(logPath, 'a');
  try {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ...env }
    });
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

function requirePid(child: ChildProcess, label: string): number {
  if (!child.pid) {
    throw cliError('runtime_launch_failed', `Debrute ${label} process did not report a pid.`);
  }
  return child.pid;
}

async function resolveSourceCheckoutRoot(startDir: string): Promise<string | undefined> {
  let current = resolve(startDir);
  while (true) {
    if (await isSourceCheckoutRoot(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function isSourceCheckoutRoot(path: string): Promise<boolean> {
  return await fileExists(resolve(path, 'package.json'))
    && await fileExists(resolve(path, 'pnpm-workspace.yaml'))
    && await fileExists(resolve(path, 'apps/web/package.json'))
    && await fileExists(resolve(path, 'apps/daemon/package.json'));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function resolveWorkbenchRuntimeEntryDir(
  importMetaUrl?: string,
  execPath = packagedExecutablePath()
): string {
  const moduleUrl = arguments.length === 0 ? import.meta.url : importMetaUrl;
  return typeof moduleUrl === 'string' && moduleUrl.startsWith('file:')
    ? dirname(fileURLToPath(moduleUrl))
    : dirname(packagedExecutablePath(execPath));
}

interface PnpmCommand {
  command: string;
  args: string[];
}

function packageManagerCommand(sourceRoot: string, args: string[]): PnpmCommand {
  const packageManager = readDeclaredPackageManager(sourceRoot);
  if (packageManager.name !== 'pnpm') {
    throw cliError('runtime_launch_failed', `Unsupported package manager: ${packageManager.raw}. Debrute requires pnpm.`);
  }

  const corepackEntrypoint = resolve(dirname(process.execPath), 'node_modules/corepack/dist/corepack.js');
  if (existsSync(corepackEntrypoint)) {
    return {
      command: process.execPath,
      args: [corepackEntrypoint, packageManager.name, ...args]
    };
  }

  if (process.platform === 'win32') {
    throw cliError('runtime_launch_failed', 'Corepack is required to launch pnpm from Debrute on Windows.');
  }

  return {
    command: packageManager.name,
    args
  };
}

function readDeclaredPackageManager(sourceRoot: string): { raw: string; name: string } {
  const packageJsonPath = resolve(sourceRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { packageManager?: unknown };
  const raw = packageJson.packageManager;
  if (typeof raw !== 'string') {
    throw cliError('runtime_launch_failed', `Missing packageManager in ${packageJsonPath}.`);
  }
  const match = /^([a-z0-9-]+)@/.exec(raw);
  if (!match) {
    throw cliError('runtime_launch_failed', `Invalid packageManager in ${packageJsonPath}: ${raw}`);
  }
  return {
    raw,
    name: match[1]!
  };
}
