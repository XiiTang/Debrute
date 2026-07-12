import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  createDebruteDaemonHttpServer,
  ManagedProductCliService,
  ProductUpdateService,
  type DebruteReplacementHelperCommand,
  type DebruteDaemonHttpServer,
  type DebruteDaemonHttpServerOptions,
  type DebruteManagedCliService,
  type DebruteProductUpdateService
} from '@debrute/daemon';
import { parseRuntimeHostConfig, type RuntimeHostConfig } from './runtimeHostConfig.js';

export interface RuntimeHostServices {
  createManagedCliService?: (config: RuntimeHostConfig) => RuntimeHostManagedCliService;
  createProductUpdateService?: (
    config: RuntimeHostConfig,
    managedCli: DebruteManagedCliService
  ) => DebruteProductUpdateService;
  createDaemonServer?: (options: DebruteDaemonHttpServerOptions) => Pick<DebruteDaemonHttpServer, 'listen' | 'close'>;
  registerProcessHandlers?: boolean;
}

interface RuntimeHostManagedCliService extends DebruteManagedCliService {
  replacementHelperCommand(): DebruteReplacementHelperCommand;
}

export async function runRuntimeHost(config: RuntimeHostConfig = parseRuntimeHostConfig({
  env: process.env
}), services: RuntimeHostServices = {}): Promise<void> {
  const token = (await readFile(config.tokenFile, 'utf8')).trim();
  if (!token) {
    throw new Error('Debrute runtime host token file is empty.');
  }
  const managedCli = services.createManagedCliService?.(config) ?? new ManagedProductCliService({
    productVersion: config.productVersion,
    cliPayloadDir: config.cliPayloadDir,
    skillsPayloadDir: config.skillsPayloadDir,
    managedBinDir: config.managedBinDir,
    managedProductRoot: config.managedProductRoot,
    productManifestPath: config.productManifestPath,
    webDistDir: config.webDistDir,
    desktopInstallPath: config.desktopInstallPath,
    replacementHelperPath: config.replacementHelperPath
  });
  await managedCli.ensureCurrent();
  const productUpdate = services.createProductUpdateService
    ? services.createProductUpdateService(config, managedCli)
    : createDefaultProductUpdateService(config, managedCli);
  const createDaemonServer = services.createDaemonServer ?? createDebruteDaemonHttpServer;
  const server = createDaemonServer({
    host: config.host,
    port: config.daemonPort,
    token,
    productServices: {
      managedCli,
      productUpdate
    },
    webBaseUrl: null,
    webDistDir: config.webDistDir
  });
  await server.listen();

  if (services.registerProcessHandlers === false) {
    return;
  }
  const close = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

const INTERNAL_PRODUCT_REPLACEMENT_HELPER_COMMAND = 'internal-product-replacement-helper';

function createDefaultProductUpdateService(
  config: RuntimeHostConfig,
  managedCli: RuntimeHostManagedCliService
): ProductUpdateService {
  const replacementHelperCommand = managedCli.replacementHelperCommand();
  return new ProductUpdateService({
    productVersion: config.productVersion,
    cliDiagnostic: () => managedCli.diagnostic(),
    desktopInstallPath: config.desktopInstallPath,
    managedProductRoot: config.managedProductRoot,
    spawnReplacementHelper: createRuntimeHostReplacementHelperSpawner(replacementHelperCommand),
    requestDesktopQuit: createDesktopQuitRequester(config.desktopPid),
    exitRuntime: createRuntimeExit,
    ...(config.desktopPid !== undefined ? { desktopPid: config.desktopPid } : {})
  });
}

function createRuntimeHostReplacementHelperSpawner(command: DebruteReplacementHelperCommand): (planPath: string) => Promise<void> {
  return async (planPath) => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.executablePath, [
        INTERNAL_PRODUCT_REPLACEMENT_HELPER_COMMAND,
        command.helperPath,
        planPath
      ], {
        detached: true,
        stdio: 'ignore'
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  };
}

function createDesktopQuitRequester(desktopPid: number | undefined): () => void {
  return () => {
    if (desktopPid !== undefined && desktopPid !== process.pid) {
      signalProcess(desktopPid, 'SIGTERM');
    }
  };
}

function createRuntimeExit(): void {
  setTimeout(() => process.exit(0), 50);
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

function isMissingProcessError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ESRCH';
}
