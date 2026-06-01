import type {
  IntegrationCatalogItem,
  IntegrationCommand,
  IntegrationOperationDiagnostic,
  IntegrationOperationKind,
  IntegrationProbeErrorKind,
  PythonCliInstallerId,
  PythonCliIntegrationCatalogItem,
  SystemPackageIntegrationCatalogItem,
  SystemPackageManagerId
} from './IntegrationCatalog.js';
import { resolveExecutable, runIntegrationCommand, type IntegrationCommandInput, type IntegrationCommandResult } from './IntegrationCommandRunner.js';

export { runIntegrationCommand, type IntegrationCommandInput, type IntegrationCommandResult } from './IntegrationCommandRunner.js';

export interface DetectIntegrationBackendOptions {
  platform?: NodeJS.Platform;
  envPath?: string;
  pathExt?: string;
}

export interface ResolvedSystemPackageManagerStatus {
  kind: 'system-package-manager';
  backend?: SystemPackageManagerId;
  manager?: SystemPackageManagerId;
  available: boolean;
  unavailableReason?: string;
  path?: string;
  queryPath?: string;
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
const PACKAGE_NOT_INSTALLED_REASON = 'Package manager does not report this package as installed.';

export async function detectSystemPackageManager(
  options: DetectIntegrationBackendOptions = {}
): Promise<ResolvedSystemPackageManagerStatus> {
  const platform = options.platform ?? process.platform;
  const envPath = options.envPath ?? process.env.PATH ?? '';
  const pathExt = options.pathExt ?? process.env.PATHEXT ?? '';

  if (platform === 'darwin') {
    const brew = await resolveExecutable('brew', envPath, platform, pathExt);
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
    const winget = await resolveExecutable('winget', envPath, platform, pathExt);
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
    const aptGet = await resolveExecutable('apt-get', envPath, platform, pathExt);
    const aptCache = await resolveExecutable('apt-cache', envPath, platform, pathExt);
    return aptGet && aptCache
      ? { kind: 'system-package-manager', backend: 'apt', manager: 'apt', path: aptGet, queryPath: aptCache, available: true }
      : {
          kind: 'system-package-manager',
          backend: 'apt',
          manager: 'apt',
          available: false,
          unavailableReason: 'APT was not found on PATH.'
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

  const uv = await resolveExecutable('uv', envPath, platform, pathExt);
  if (uv) {
    return { kind: 'python-cli-installer', backend: 'uv', installer: 'uv', path: uv, available: true };
  }
  const pipx = await resolveExecutable('pipx', envPath, platform, pathExt);
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
      ['outdated', '--json=v2', '--formula', packageName],
      `brew outdated --json=v2 --formula ${packageName}`
    );
  }
  if (backend.manager === 'winget') {
    return command(
      backend.manager,
      backend.path,
      ['upgrade', '--id', packageName, '--exact', '--disable-interactivity'],
      `winget upgrade --id ${packageName} --exact --disable-interactivity`
    );
  }
  if (!backend.queryPath) {
    return undefined;
  }
  return command(backend.manager, backend.queryPath, ['policy', packageName], `apt-cache policy ${packageName}`);
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
      ['info', '--json=v2', '--formula', packageName],
      `brew info --json=v2 --formula ${packageName}`
    );
  }
  if (backend.manager === 'winget') {
    return command(
      backend.manager,
      backend.path,
      ['show', '--id', packageName, '--exact', '--disable-interactivity'],
      `winget show --id ${packageName} --exact --disable-interactivity`
    );
  }
  if (!backend.queryPath) {
    return undefined;
  }
  return command(backend.manager, backend.queryPath, ['policy', packageName], `apt-cache policy ${packageName}`);
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
  if (manager === 'winget') {
    return parseWingetUpgrade(packageName, stdout);
  }
  return parseAptPolicy(stdout);
}

export function parseSystemInstallQueryOutput(
  manager: SystemPackageManagerId,
  packageName: string,
  stdout: string
): ParsedIntegrationQuery {
  if (manager === 'brew') {
    return parseBrewInfo(packageName, stdout);
  }
  if (manager === 'winget') {
    return parseWingetShow(stdout);
  }
  const apt = parseAptPolicy(stdout);
  return {
    ...(apt.latestVersion ? { latestVersion: apt.latestVersion } : {}),
    updateAvailable: false
  };
}

export function queryTimeoutMs(): number {
  return QUERY_TIMEOUT_MS;
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
    return command(backend.manager, backend.path, args, `brew ${args.join(' ')}`);
  }
  if (backend.manager === 'winget') {
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
    return command(backend.manager, backend.path, args, `winget ${args.join(' ')}`);
  }

  const args = kind === 'install'
    ? ['install', '-y', packageName]
    : kind === 'update'
      ? ['install', '--only-upgrade', '-y', packageName]
      : ['remove', '-y', packageName];
  return command(backend.manager, backend.path, args, `apt-get ${args.join(' ')}`);
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
    return { backend: 'uv', file: backend.path, args, preview: `uv ${args.join(' ')}` };
  }
  const args = kind === 'install'
    ? ['install', integration.pythonCli.repository]
    : kind === 'update'
      ? ['upgrade', packageName]
      : ['uninstall', packageName];
  return { backend: 'pipx', file: backend.path, args, preview: `pipx ${args.join(' ')}` };
}

function command(
  backend: SystemPackageManagerId,
  file: string,
  args: string[],
  preview: string
): IntegrationCommand {
  return { backend, file, args, preview };
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

function parseAptPolicy(stdout: string): ParsedIntegrationQuery {
  const installedVersion = stdout.match(/Installed:\s*(\S+)/)?.[1];
  const latestVersion = stdout.match(/Candidate:\s*(\S+)/)?.[1];
  const installedMissing = !installedVersion || installedVersion === '(none)';
  return {
    ...(installedVersion && !installedMissing ? { installedVersion } : {}),
    ...(latestVersion && latestVersion !== '(none)' ? { latestVersion } : {}),
    updateAvailable: Boolean(!installedMissing && latestVersion && installedVersion !== latestVersion),
    ...(installedMissing ? { unavailableReason: PACKAGE_NOT_INSTALLED_REASON } : {})
  };
}
