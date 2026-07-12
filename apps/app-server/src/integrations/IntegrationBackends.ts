import type {
  IntegrationCatalogItem,
  IntegrationCommand,
  IntegrationOperationKind,
  PythonCliInstallerId,
  PythonCliIntegrationCatalogItem,
  SystemPackageIntegrationCatalogItem,
  SystemPackageManagerId
} from './IntegrationCatalog.js';
import {
  nodeIntegrationProcessAdapter,
  type IntegrationProcessAdapter
} from './IntegrationCommandRunner.js';

export interface DetectIntegrationBackendOptions {
  platform?: NodeJS.Platform;
  envPath?: string;
  pathExt?: string;
  processAdapter?: IntegrationProcessAdapter;
}

export interface ResolvedSystemPackageManagerStatus {
  kind: 'system-package-manager';
  backend?: SystemPackageManagerId;
  manager?: SystemPackageManagerId;
  available: boolean;
  unavailableReason?: string;
  path?: string;
}

export interface ResolvedPythonCliInstallerStatus {
  kind: 'python-cli-installer';
  backend?: PythonCliInstallerId;
  installer?: PythonCliInstallerId;
  available: boolean;
  unavailableReason?: string;
  path?: string;
}

export interface ParsedIntegrationQuery {
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  unavailableReason?: string;
}

const QUERY_TIMEOUT_MS = 20_000;
const OPERATION_TIMEOUT_MS = 300_000;
const PACKAGE_NOT_INSTALLED_REASON = 'Package manager does not report this package as installed.';

export async function detectSystemPackageManager(
  options: DetectIntegrationBackendOptions = {}
): Promise<ResolvedSystemPackageManagerStatus> {
  const platform = options.platform ?? process.platform;
  const envPath = options.envPath ?? process.env.PATH ?? '';
  const pathExt = options.pathExt ?? process.env.PATHEXT ?? '';
  const processAdapter = options.processAdapter ?? nodeIntegrationProcessAdapter;

  if (platform === 'darwin') {
    const brew = await processAdapter.resolveExecutable('brew', envPath, platform, pathExt);
    return brew
      ? { kind: 'system-package-manager', backend: 'brew', manager: 'brew', path: brew, available: true }
      : {
          kind: 'system-package-manager',
          backend: 'brew',
          manager: 'brew',
          available: false,
          unavailableReason: 'Homebrew was not found on PATH.'
        };
  }
  if (platform === 'win32') {
    const winget = await processAdapter.resolveExecutable('winget', envPath, platform, pathExt);
    return winget
      ? { kind: 'system-package-manager', backend: 'winget', manager: 'winget', path: winget, available: true }
      : {
          kind: 'system-package-manager',
          backend: 'winget',
          manager: 'winget',
          available: false,
          unavailableReason: 'winget was not found on PATH.'
        };
  }
  if (platform === 'linux') {
    return {
      kind: 'system-package-manager',
      available: false,
      unavailableReason: 'System package integration operations are not supported on linux.'
    };
  }

  return {
    kind: 'system-package-manager',
    available: false,
    unavailableReason: `Integration installation is not supported on ${platform}.`
  };
}

export async function detectPythonCliInstaller(
  options: DetectIntegrationBackendOptions = {}
): Promise<ResolvedPythonCliInstallerStatus> {
  const platform = options.platform ?? process.platform;
  const envPath = options.envPath ?? process.env.PATH ?? '';
  const pathExt = options.pathExt ?? process.env.PATHEXT ?? '';
  const processAdapter = options.processAdapter ?? nodeIntegrationProcessAdapter;

  const uv = await processAdapter.resolveExecutable('uv', envPath, platform, pathExt);
  if (uv) {
    return { kind: 'python-cli-installer', backend: 'uv', installer: 'uv', path: uv, available: true };
  }
  const pipx = await processAdapter.resolveExecutable('pipx', envPath, platform, pathExt);
  if (pipx) {
    return { kind: 'python-cli-installer', backend: 'pipx', installer: 'pipx', path: pipx, available: true };
  }
  return {
    kind: 'python-cli-installer',
    available: false,
    unavailableReason: 'uv or pipx was not found on PATH.'
  };
}

export function buildIntegrationQueryCommand(
  integration: IntegrationCatalogItem,
  backend: ResolvedSystemPackageManagerStatus | ResolvedPythonCliInstallerStatus
): IntegrationCommand | undefined {
  if (integration.backend !== 'system-package-manager' || backend.kind !== 'system-package-manager') {
    return undefined;
  }
  if (!backend.available || !backend.manager || !backend.path) {
    return undefined;
  }

  const packageName = integration.packages[backend.manager].packageName;
  if (backend.manager === 'brew') {
    return command(
      backend.manager,
      backend.path,
      ['outdated', '--json=v2', '--formula', packageName]
    );
  }
  return command(
    backend.manager,
    backend.path,
    ['upgrade', '--id', packageName, '--exact', '--disable-interactivity']
  );
}

export function buildIntegrationInstallQueryCommand(
  integration: IntegrationCatalogItem,
  backend: ResolvedSystemPackageManagerStatus | ResolvedPythonCliInstallerStatus
): IntegrationCommand | undefined {
  if (integration.backend !== 'system-package-manager' || backend.kind !== 'system-package-manager') {
    return undefined;
  }
  if (!backend.available || !backend.manager || !backend.path) {
    return undefined;
  }

  const packageName = integration.packages[backend.manager].packageName;
  if (backend.manager === 'brew') {
    return command(
      backend.manager,
      backend.path,
      ['info', '--json=v2', '--formula', packageName]
    );
  }
  return command(
    backend.manager,
    backend.path,
    ['show', '--id', packageName, '--exact', '--disable-interactivity']
  );
}

export function buildIntegrationOperationCommand(
  integration: IntegrationCatalogItem,
  backend: ResolvedSystemPackageManagerStatus | ResolvedPythonCliInstallerStatus,
  kind: IntegrationOperationKind
): IntegrationCommand | undefined {
  if (integration.backend === 'python-cli-installer') {
    return backend.kind === 'python-cli-installer'
      ? buildPythonCliCommand(integration, backend, kind)
      : undefined;
  }
  return backend.kind === 'system-package-manager'
    ? buildSystemPackageCommand(integration, backend, kind)
    : undefined;
}

export function parseSystemPackageQueryOutput(
  manager: SystemPackageManagerId,
  packageName: string,
  stdout: string
): ParsedIntegrationQuery {
  if (manager === 'brew') {
    return parseBrewOutdated(packageName, stdout);
  }
  return parseWingetUpgrade(packageName, stdout);
}

export function parseSystemInstallQueryOutput(
  manager: SystemPackageManagerId,
  packageName: string,
  stdout: string
): ParsedIntegrationQuery {
  if (manager === 'brew') {
    return parseBrewInfo(packageName, stdout);
  }
  return parseWingetShow(stdout);
}

export function queryTimeoutMs(): number {
  return QUERY_TIMEOUT_MS;
}

export function operationTimeoutMs(): number {
  return OPERATION_TIMEOUT_MS;
}

function buildSystemPackageCommand(
  integration: SystemPackageIntegrationCatalogItem,
  backend: ResolvedSystemPackageManagerStatus,
  kind: IntegrationOperationKind
): IntegrationCommand | undefined {
  if (!backend.available || !backend.manager || !backend.path) {
    return undefined;
  }

  const packageName = integration.packages[backend.manager].packageName;
  if (backend.manager === 'brew') {
    const commandName = kind === 'install' ? 'install' : kind === 'update' ? 'upgrade' : 'uninstall';
    const args = [commandName, '--formula', packageName];
    return command(backend.manager, backend.path, args);
  }

  const commandName = kind === 'install' ? 'install' : kind === 'update' ? 'upgrade' : 'uninstall';
  const args = commandName === 'uninstall'
    ? [commandName, '--id', packageName, '--exact', '--disable-interactivity']
    : [
        commandName,
        '--id',
        packageName,
        '--exact',
        '--accept-source-agreements',
        '--accept-package-agreements',
        '--disable-interactivity'
      ];
  return command(backend.manager, backend.path, args);
}

function buildPythonCliCommand(
  integration: PythonCliIntegrationCatalogItem,
  backend: ResolvedPythonCliInstallerStatus,
  kind: IntegrationOperationKind
): IntegrationCommand | undefined {
  if (!backend.available || !backend.installer || !backend.path) {
    return undefined;
  }
  const packageName = integration.pythonCli.packageName;
  if (backend.installer === 'uv') {
    const args = kind === 'install'
      ? ['tool', 'install', integration.pythonCli.repository]
      : kind === 'update'
        ? ['tool', 'upgrade', packageName]
        : ['tool', 'uninstall', packageName];
    return { backend: 'uv', file: backend.path, args };
  }
  const args = kind === 'install'
    ? ['install', integration.pythonCli.repository]
    : kind === 'update'
      ? ['upgrade', packageName]
      : ['uninstall', packageName];
  return { backend: 'pipx', file: backend.path, args };
}

function command(
  backend: SystemPackageManagerId,
  file: string,
  args: string[]
): IntegrationCommand {
  return { backend, file, args };
}

function parseBrewOutdated(packageName: string, stdout: string): ParsedIntegrationQuery {
  const parsed = JSON.parse(stdout || '{"formulae":[],"casks":[]}') as {
    formulae?: Array<{ name: string; installed_versions?: string[]; current_version?: string }>;
  };
  const formula = parsed.formulae?.find((entry) => entry.name === packageName);
  return {
    ...(formula?.installed_versions?.[0] ? { installedVersion: formula.installed_versions[0] } : {}),
    ...(formula?.current_version ? { latestVersion: formula.current_version } : {}),
    updateAvailable: Boolean(formula)
  };
}

function parseBrewInfo(packageName: string, stdout: string): ParsedIntegrationQuery {
  const parsed = JSON.parse(stdout || '{"formulae":[]}') as {
    formulae?: Array<{ name: string; versions?: { stable?: string } }>;
  };
  const formula = parsed.formulae?.find((entry) => entry.name === packageName) ?? parsed.formulae?.[0];
  return {
    ...(formula?.versions?.stable ? { latestVersion: formula.versions.stable } : {}),
    updateAvailable: false
  };
}

function parseWingetShow(stdout: string): ParsedIntegrationQuery {
  const latestVersion = stdout.match(/^Version:\s*(\S+)/mi)?.[1];
  return {
    ...(latestVersion ? { latestVersion } : {}),
    updateAvailable: false
  };
}

function parseWingetUpgrade(packageName: string, stdout: string): ParsedIntegrationQuery {
  const line = stdout.split(/\r?\n/).find((entry) => entry.includes(packageName));
  if (!line) {
    if (/no available upgrade|no applicable update|no upgrade/i.test(stdout)) {
      return { updateAvailable: false };
    }
    return { updateAvailable: false, unavailableReason: PACKAGE_NOT_INSTALLED_REASON };
  }
  const columns = line.trim().split(/\s{2,}/);
  return {
    ...(columns[2] ? { installedVersion: columns[2] } : {}),
    ...(columns[3] ? { latestVersion: columns[3] } : {}),
    updateAvailable: Boolean(columns[2] && columns[3] && columns[2] !== columns[3])
  };
}
