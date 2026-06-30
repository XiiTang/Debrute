import {
  INTEGRATION_CATALOG,
  type IntegrationBackendStatus,
  type IntegrationBinaryStatus,
  type IntegrationCatalogBinary,
  type IntegrationCatalogItem,
  type IntegrationOperationDiagnostic,
  type IntegrationOperationInFlight,
  type IntegrationOperationKind,
  type IntegrationOperationStatus,
  type RunIntegrationOperationInput,
  type RunIntegrationOperationResult,
  type IntegrationSettingsView,
  type IntegrationStatus,
  type IntegrationStatusKind
} from './IntegrationCatalog.js';
import {
  buildIntegrationInstallQueryCommand,
  buildIntegrationOperationCommand,
  buildIntegrationQueryCommand,
  detectPythonCliInstaller,
  detectSystemPackageManager,
  operationTimeoutMs,
  parseSystemInstallQueryOutput,
  parseSystemPackageQueryOutput,
  queryTimeoutMs,
  type ResolvedPythonCliInstallerStatus,
  type ResolvedSystemPackageManagerStatus
} from './IntegrationBackends.js';
import { resolveExecutable, runIntegrationCommand, runProbe, tail } from './IntegrationCommandRunner.js';

export interface IntegrationsServiceOptions {
  envPath?: string;
  platform?: NodeJS.Platform;
  pathExt?: string;
  cacheTtlMs?: number;
}

interface ResolvedBackends {
  systemPackageManager: ResolvedSystemPackageManagerStatus;
  pythonCliInstaller: ResolvedPythonCliInstallerStatus;
}

interface IntegrationPackageQueryStatus {
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  queryDiagnostic?: IntegrationOperationDiagnostic;
  unavailableReason?: string;
}

export interface IntegrationsServiceOperationCallbacks {
  onStarted?: (settings: IntegrationSettingsView) => void | Promise<void>;
  onSettled?: (settings: IntegrationSettingsView) => void | Promise<void>;
}

export class IntegrationsService {
  private readonly cacheTtlMs: number;
  private cached: { createdAt: number; view: IntegrationSettingsView } | undefined;
  private operationLock: RunIntegrationOperationInput | undefined;
  private runningOperation: IntegrationOperationInFlight | undefined;

  constructor(private readonly options: IntegrationsServiceOptions) {
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
  }

  async listStatus(): Promise<IntegrationSettingsView> {
    if (this.cached && Date.now() - this.cached.createdAt < this.cacheTtlMs) {
      return settingsWithRunningOperation(this.cached.view, this.runningOperation);
    }
    return this.rescan();
  }

  async rescan(): Promise<IntegrationSettingsView> {
    return this.scanIntegrations();
  }

  async runOperation(
    input: RunIntegrationOperationInput,
    callbacks: IntegrationsServiceOperationCallbacks = {}
  ): Promise<RunIntegrationOperationResult> {
    if (this.operationLock) {
      const settings = await this.listStatus();
      return {
        ok: false,
        integrationId: input.integrationId,
        operation: input.operation,
        settings,
        diagnostic: { errorKind: 'operation_already_running' }
      };
    }

    let ok = false;
    let diagnostic: IntegrationOperationDiagnostic | undefined;
    let settings: IntegrationSettingsView;

    this.operationLock = input;
    try {
      const integration = INTEGRATION_CATALOG.find((entry) => entry.id === input.integrationId);
      if (!integration) {
        settings = await this.scanIntegrations();
        return operationResult(input, settings, false, { errorKind: 'integration_not_found' });
      }

      const inspected = await this.inspectIntegrations();
      this.cached = { createdAt: Date.now(), view: inspected.view };
      const backend = integration.backend === 'python-cli-installer'
        ? inspected.backends.pythonCliInstaller
        : inspected.backends.systemPackageManager;
      const status = inspected.view.integrations.find((entry) => entry.integrationId === input.integrationId);
      if (!backend.available) {
        return operationResult(input, inspected.view, false, {
          errorKind: 'backend_unavailable',
          ...(backend.unavailableReason ? { stderrTail: backend.unavailableReason } : {})
        });
      }
      if (!status?.operationStatus?.availableOperations.includes(input.operation)) {
        return operationResult(input, inspected.view, false, { errorKind: 'operation_unavailable' });
      }

      const command = buildIntegrationOperationCommand(integration, backend, input.operation);
      if (!command) {
        return operationResult(input, inspected.view, false, { errorKind: 'command_unavailable' });
      }

      this.runningOperation = { integrationId: input.integrationId, operation: input.operation };

      try {
        await callbacks.onStarted?.(settingsWithRunningOperation(inspected.view, this.runningOperation));
        const result = await runIntegrationCommand({
          file: command.file,
          args: command.args,
          timeoutMs: operationTimeoutMs()
        });
        ok = result.ok;
        if (!result.ok) {
          diagnostic = result.diagnostic;
        }
      } finally {
        this.runningOperation = undefined;
        this.cached = undefined;
        settings = await this.scanIntegrations();
      }

      await callbacks.onSettled?.(settings);
      return operationResult(input, settings, ok, diagnostic);
    } finally {
      this.operationLock = undefined;
    }
  }

  private async scanIntegrations(): Promise<IntegrationSettingsView> {
    const { view } = await this.inspectIntegrations();
    this.cached = { createdAt: Date.now(), view };
    return settingsWithRunningOperation(view, this.runningOperation);
  }

  private async inspectIntegrations(): Promise<{
    view: IntegrationSettingsView;
    backends: ResolvedBackends;
  }> {
    const backendOptions = {
      ...(this.options.platform ? { platform: this.options.platform } : {}),
      envPath: this.options.envPath ?? process.env.PATH ?? '',
      pathExt: this.options.pathExt ?? process.env.PATHEXT ?? ''
    };
    const [systemPackageManager, pythonCliInstaller] = await Promise.all([
      detectSystemPackageManager(backendOptions),
      detectPythonCliInstaller(backendOptions)
    ]);
    const backends = { systemPackageManager, pythonCliInstaller };
    const integrations = await Promise.all(INTEGRATION_CATALOG.map((integration) => (
      this.inspectIntegration(integration, backends)
    )));
    const view: IntegrationSettingsView = {
      integrations,
      backends: [
        backendView(systemPackageManager),
        backendView(pythonCliInstaller)
      ]
    };
    return { view, backends };
  }

  private async inspectIntegration(
    integration: IntegrationCatalogItem,
    backends: ResolvedBackends
  ): Promise<IntegrationStatus> {
    const binaries = await Promise.all(integration.binaries.map((binary) => this.inspectBinary(binary)));
    const status = aggregateIntegrationStatus(binaries);
    const operationStatus = await this.inspectOperationStatus(integration, status, backends);
    return {
      integrationId: integration.id,
      displayName: integration.displayName,
      description: integration.description,
      category: integration.category,
      status,
      summary: summarizeIntegrationStatus(status, binaries),
      binaries,
      ...(operationStatus ? { operationStatus } : {})
    };
  }

  private async inspectOperationStatus(
    integration: IntegrationCatalogItem,
    status: IntegrationStatusKind,
    backends: ResolvedBackends
  ): Promise<IntegrationOperationStatus> {
    if (integration.backend === 'python-cli-installer') {
      return this.inspectPythonCliStatus(integration, status, backends.pythonCliInstaller);
    }
    return this.inspectSystemPackageStatus(integration, status, backends.systemPackageManager);
  }

  private async inspectSystemPackageStatus(
    integration: Extract<IntegrationCatalogItem, { backend: 'system-package-manager' }>,
    status: IntegrationStatusKind,
    backend: ResolvedSystemPackageManagerStatus
  ): Promise<IntegrationOperationStatus> {
    const packageName = backend.manager ? integration.packages[backend.manager].packageName : undefined;
    const base: Omit<IntegrationOperationStatus, 'availableOperations'> = {
      backendKind: 'system-package-manager',
      ...(backend.backend ? { backend: backend.backend } : {}),
      ...(packageName ? { packageName } : {})
    };

    if (!backend.available) {
      return operationStatus({
        ...base,
        unavailableReason: backend.unavailableReason ?? 'System package manager is unavailable.'
      }, []);
    }

    const installCommand = buildIntegrationOperationCommand(integration, backend, 'install');
    const updateCommand = buildIntegrationOperationCommand(integration, backend, 'update');
    const uninstallCommand = buildIntegrationOperationCommand(integration, backend, 'uninstall');
    if (status === 'not_found') {
      const query = installCommand ? await this.queryInstallPackageStatus(integration, backend) : { updateAvailable: false };
      return operationStatus({
        ...base,
        ...operationQueryFields(query)
      }, installCommand ? ['install'] : []);
    }
    if (status !== 'ready') {
      return operationStatus({
        ...base,
        unavailableReason: 'Integration operations require a ready detected integration.'
      }, []);
    }

    const query = await this.queryPackageStatus(integration, backend);
    return operationStatus({
      ...base,
      ...operationQueryFields(query)
    }, [
      ...(updateCommand && query.updateAvailable ? ['update' as const] : []),
      ...(uninstallCommand ? ['uninstall' as const] : [])
    ]);
  }

  private async inspectPythonCliStatus(
    integration: Extract<IntegrationCatalogItem, { backend: 'python-cli-installer' }>,
    status: IntegrationStatusKind,
    backend: ResolvedPythonCliInstallerStatus
  ): Promise<IntegrationOperationStatus> {
    const base: Omit<IntegrationOperationStatus, 'availableOperations'> = {
      backendKind: 'python-cli-installer',
      ...(backend.backend ? { backend: backend.backend } : {}),
      packageName: integration.pythonCli.packageName
    };

    if (!backend.available) {
      return operationStatus({
        ...base,
        unavailableReason: backend.unavailableReason ?? 'Python CLI installer is unavailable.'
      }, []);
    }

    const installCommand = buildIntegrationOperationCommand(integration, backend, 'install');
    const updateCommand = buildIntegrationOperationCommand(integration, backend, 'update');
    const uninstallCommand = buildIntegrationOperationCommand(integration, backend, 'uninstall');
    if (status === 'not_found') {
      return operationStatus({
        ...base,
      }, installCommand ? ['install'] : []);
    }
    if (status !== 'ready') {
      return operationStatus({
        ...base,
        unavailableReason: 'Integration operations require a ready detected integration.'
      }, []);
    }

    return operationStatus({
      ...base,
    }, [
      ...(updateCommand ? ['update' as const] : []),
      ...(uninstallCommand ? ['uninstall' as const] : [])
    ]);
  }

  private async queryPackageStatus(
    integration: Extract<IntegrationCatalogItem, { backend: 'system-package-manager' }>,
    backend: ResolvedSystemPackageManagerStatus
  ): Promise<IntegrationPackageQueryStatus> {
    const queryCommand = buildIntegrationQueryCommand(integration, backend);
    if (!queryCommand || !backend.manager) {
      return { updateAvailable: false };
    }

    const result = await runIntegrationCommand({
      file: queryCommand.file,
      args: queryCommand.args,
      timeoutMs: queryTimeoutMs()
    });
    const brewOutdatedJson = backend.manager === 'brew' && result.stdout.trim();
    if (!result.ok && !brewOutdatedJson) {
      return { updateAvailable: false, queryDiagnostic: result.diagnostic };
    }

    try {
      return parseSystemPackageQueryOutput(backend.manager, integration.packages[backend.manager].packageName, result.stdout);
    } catch (error) {
      return {
        updateAvailable: false,
        queryDiagnostic: {
          errorKind: 'parse_error',
          stderrTail: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private async queryInstallPackageStatus(
    integration: Extract<IntegrationCatalogItem, { backend: 'system-package-manager' }>,
    backend: ResolvedSystemPackageManagerStatus
  ): Promise<IntegrationPackageQueryStatus> {
    const queryCommand = buildIntegrationInstallQueryCommand(integration, backend);
    if (!queryCommand || !backend.manager) {
      return { updateAvailable: false };
    }

    const result = await runIntegrationCommand({
      file: queryCommand.file,
      args: queryCommand.args,
      timeoutMs: queryTimeoutMs()
    });
    if (!result.ok) {
      return { updateAvailable: false, queryDiagnostic: result.diagnostic };
    }

    try {
      return parseSystemInstallQueryOutput(backend.manager, integration.packages[backend.manager].packageName, result.stdout);
    } catch (error) {
      return {
        updateAvailable: false,
        queryDiagnostic: {
          errorKind: 'parse_error',
          stderrTail: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private async inspectBinary(binary: IntegrationCatalogBinary): Promise<IntegrationBinaryStatus> {
    const path = await this.resolveDefaultBinaryPath(binary);
    if (!path) {
      return {
        binaryId: binary.id,
        displayName: binary.displayName,
        status: 'not_found'
      };
    }

    const probe = await runProbe(path, binary.probe.args, binary.probe.timeoutMs);
    if (!probe.ok) {
      return {
        binaryId: binary.id,
        displayName: binary.displayName,
        status: 'probe_failed',
        probe: {
          ...(probe.exitCode !== undefined ? { exitCode: probe.exitCode } : {}),
          ...(probe.errorKind ? { errorKind: probe.errorKind } : {}),
          ...(probe.stderr ? { stderrTail: tail(probe.stderr) } : {})
        }
      };
    }

    const version = parseVersion(binary, probe.stdout);
    return {
      binaryId: binary.id,
      displayName: binary.displayName,
      status: 'ready',
      ...(version ? { version } : {})
    };
  }

  private async resolveDefaultBinaryPath(binary: IntegrationCatalogBinary): Promise<string | undefined> {
    const platform = this.options.platform ?? process.platform;
    for (const name of binary.names) {
      const path = await resolveExecutable(name, this.options.envPath ?? process.env.PATH ?? '', platform, this.options.pathExt ?? process.env.PATHEXT ?? '');
      if (path) {
        return path;
      }
    }
    return undefined;
  }
}

function aggregateIntegrationStatus(binaries: IntegrationBinaryStatus[]): IntegrationStatusKind {
  if (binaries.some((binary) => binary.status === 'probe_failed')) {
    return 'probe_failed';
  }
  if (binaries.some((binary) => binary.status === 'not_found')) {
    return 'not_found';
  }
  return 'ready';
}

function summarizeIntegrationStatus(status: IntegrationStatusKind, binaries: IntegrationBinaryStatus[]): string {
  if (status === 'ready') {
    return 'Ready.';
  }
  if (status === 'probe_failed') {
    return `${binaries.find((binary) => binary.status === 'probe_failed')?.displayName ?? 'A required binary'} probe failed.`;
  }
  if (status === 'not_found') {
    return `${binaries.find((binary) => binary.status === 'not_found')?.displayName ?? 'A required binary'} is missing.`;
  }
  return '';
}

function backendView(backend: ResolvedSystemPackageManagerStatus | ResolvedPythonCliInstallerStatus): IntegrationBackendStatus {
  return {
    kind: backend.kind,
    ...(backend.backend ? { backend: backend.backend } : {}),
    available: backend.available,
    ...(backend.unavailableReason ? { unavailableReason: backend.unavailableReason } : {})
  };
}

function operationStatus(
  status: Omit<IntegrationOperationStatus, 'availableOperations'>,
  availableOperations: IntegrationOperationKind[]
): IntegrationOperationStatus {
  return {
    ...status,
    availableOperations
  };
}

function settingsWithRunningOperation(
  view: IntegrationSettingsView,
  runningOperation: IntegrationOperationInFlight | undefined
): IntegrationSettingsView {
  return runningOperation ? { ...view, runningOperation } : view;
}

function operationResult(
  input: RunIntegrationOperationInput,
  settings: IntegrationSettingsView,
  ok: boolean,
  diagnostic: IntegrationOperationDiagnostic | undefined
): RunIntegrationOperationResult {
  return {
    ok,
    integrationId: input.integrationId,
    operation: input.operation,
    settings,
    ...(diagnostic ? { diagnostic } : {})
  };
}

function operationQueryFields(query: IntegrationPackageQueryStatus): Pick<IntegrationOperationStatus, 'installedVersion' | 'latestVersion' | 'queryDiagnostic' | 'unavailableReason'> {
  return {
    ...(query.installedVersion !== undefined ? { installedVersion: query.installedVersion } : {}),
    ...(query.latestVersion !== undefined ? { latestVersion: query.latestVersion } : {}),
    ...(query.queryDiagnostic !== undefined ? { queryDiagnostic: query.queryDiagnostic } : {}),
    ...(query.unavailableReason !== undefined ? { unavailableReason: query.unavailableReason } : {})
  };
}

function parseVersion(binary: IntegrationCatalogBinary, stdout: string): string | undefined {
  if (binary.versionParser === 'exiftool' || binary.versionParser === 'mediainfo') {
    return stdout.match(/(?:^|[^\w])v?(\d+(?:\.\d+)+)\b/i)?.[1];
  }
  if (binary.versionParser === 'imagemagick') {
    return stdout.match(/ImageMagick\s+(\d+(?:\.\d+)+(?:-\d+)?)/i)?.[1];
  }
  return stdout.match(/\bversion\s+([^\s,]+)/i)?.[1];
}
