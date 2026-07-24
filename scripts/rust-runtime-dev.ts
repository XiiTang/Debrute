import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RuntimeControlError,
  connectRuntimeControl,
  type RuntimeControlClient
} from '@debrute/runtime-control-client';
import { prepareNativeRasterPayload } from './native-raster-payload.mjs';
import {
  MACOS_RUNTIME_APP_NAME,
  MACOS_RUNTIME_EXECUTABLE,
  assembleMacosRuntimeApplication
} from './macos-runtime-app.mjs';
import { ensureNativeRasterPayload } from './prepare-native-raster.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const developmentDirectory = join(workspaceRoot, '.scratch/rust-runtime-dev');
const runtimeBinary = join(
  workspaceRoot,
  'target/debug',
  process.platform === 'win32' ? 'debrute-runtime.exe' : 'debrute-runtime'
);
const runtimeApplication = join(developmentDirectory, MACOS_RUNTIME_APP_NAME);
const runtimeApplicationBinaryIdentityPath = join(developmentDirectory, 'runtime-app-binary-identity');
const runtimeExecutable = process.platform === 'darwin'
  ? join(runtimeApplication, MACOS_RUNTIME_EXECUTABLE)
  : runtimeBinary;
const runtimeEntrypoint = process.platform === 'darwin'
  ? join(developmentDirectory, 'debrute-runtime')
  : runtimeBinary;
const runtimeAssetsDirectory = join(developmentDirectory, 'assets');
const runtimeLogPath = join(developmentDirectory, 'runtime.log');
const RUNTIME_READY_TIMEOUT_MS = 15_000;

export interface RustRuntimeDevelopmentOptions {
  desktopEntrypoint?: string;
  desktopArguments?: string[];
  restartExisting?: boolean;
}

export async function buildRustRuntime(): Promise<boolean> {
  const previousCompiledRuntime = fileIdentity(runtimeBinary);
  await ensureNativeRasterPayload();
  const env = await prepareNativeRasterPayload({ profile: 'debug' });
  const child = spawn('cargo', [
    'build',
    '-p',
    'debrute-runtime'
  ], {
    cwd: workspaceRoot,
    stdio: 'inherit',
    env
  });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(`Debrute Runtime build failed with code ${exitCode ?? 'unknown'}.`);
  }
  const compiledRuntimeIdentity = fileIdentity(runtimeBinary);
  if (compiledRuntimeIdentity === undefined) {
    throw new Error('Debrute Runtime build did not produce its development binary.');
  }
  const rebuilt = compiledRuntimeIdentity !== previousCompiledRuntime;
  if (process.platform === 'darwin' && macosRuntimeApplicationNeedsAssembly({
    compiledRuntimeIdentity,
    installedRuntimeIdentity: optionalFileText(runtimeApplicationBinaryIdentityPath),
    runtimeExecutableExists: fileIdentity(runtimeExecutable) !== undefined
  })) {
    await assembleMacosRuntimeApplication({
      destination: runtimeApplication,
      runtimeBinary,
      nativeRasterRoot: join(workspaceRoot, 'target/debug/native-raster'),
      icon: join(workspaceRoot, 'apps/desktop/build/icon.icns'),
      version: productVersion()
    });
    await signMacosRuntimeApplication();
    await writeFile(
      runtimeEntrypoint,
      [
        '#!/bin/sh',
        `exec /usr/bin/open -g -n --env ${shellQuote(`DEBRUTE_RUNTIME_WEB_ASSETS_DIR=${runtimeAssetsDirectory}`)}`
          + ` ${shellQuote(runtimeApplication)} --args "$@" --stable-runtime-entrypoint ${shellQuote(runtimeEntrypoint)}`,
        ''
      ].join('\n'),
      'utf8'
    );
    await chmod(runtimeEntrypoint, 0o755);
    await writeFile(runtimeApplicationBinaryIdentityPath, `${compiledRuntimeIdentity}\n`, 'utf8');
  }
  return rebuilt;
}

export function macosRuntimeApplicationNeedsAssembly(input: {
  compiledRuntimeIdentity: string;
  installedRuntimeIdentity: string | undefined;
  runtimeExecutableExists: boolean;
}): boolean {
  return !input.runtimeExecutableExists
    || input.installedRuntimeIdentity !== input.compiledRuntimeIdentity;
}

export async function ensureRustRuntime(
  options: RustRuntimeDevelopmentOptions = {}
): Promise<RuntimeControlClient> {
  const readyDeadlineMs = Date.now() + RUNTIME_READY_TIMEOUT_MS;
  try {
    const existing = await connectLauncher(readyDeadlineMs);
    const inspection = await existing.inspect();
    const currentExecutableIdentity = runtimeBinaryIdentity();
    if (
      !options.restartExisting
      && inspection.result === 'inspection'
      && currentExecutableIdentity !== undefined
      && inspection.executable_identity === currentExecutableIdentity
    ) {
      await existing.waitUntilReady();
      return existing;
    }
    await stopRustRuntime(existing);
  } catch (error) {
    if (!(error instanceof RuntimeControlError) || error.code !== 'runtime_unavailable') {
      throw error;
    }
  }
  await prepareRuntimeAssets();
  const child = spawnRuntime(options);
  let lastError: unknown;
  while (Date.now() < readyDeadlineMs) {
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(
        `Debrute Runtime exited during startup with code ${child.exitCode}. See ${runtimeLogPath}.`
      );
    }
    try {
      const control = await connectLauncher(readyDeadlineMs);
      await control.waitUntilReady();
      child.unref();
      return control;
    } catch (error) {
      lastError = error;
      if (error instanceof RuntimeControlError && error.code !== 'runtime_unavailable') {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw new RuntimeControlError(
    'runtime_ready_timeout',
    `Debrute Runtime did not become Ready before the absolute deadline. See ${runtimeLogPath}.`,
    { cause: lastError }
  );
}

function runtimeBinaryIdentity(): string | undefined {
  return fileIdentity(runtimeExecutable);
}

function fileIdentity(path: string): string | undefined {
  try {
    const metadata = statSync(path, { bigint: true });
    return `${metadata.size}:${metadata.mtimeNs}`;
  } catch {
    return undefined;
  }
}

function optionalFileText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function stopRustRuntime(control: RuntimeControlClient): Promise<void> {
  const stopped = new Promise<void>((resolveStopped) => {
    control.onRuntimeLost(() => resolveStopped());
  });
  const response = await control.quitProduct();
  if (response.result !== 'ok') {
    control.close();
    throw new Error(`Existing Debrute Runtime rejected its development restart: ${response.result}.`);
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      stopped,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Existing Debrute Runtime did not stop for the development rebuild.')),
          RUNTIME_READY_TIMEOUT_MS
        );
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function chooseDevelopmentPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Development port allocation failed.');
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return address.port;
}

export function productVersion(): string {
  const parsed = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('Debrute product version is invalid.');
  }
  return parsed.version;
}

export { runtimeAssetsDirectory, runtimeEntrypoint, workspaceRoot };

async function connectLauncher(readyDeadlineMs: number): Promise<RuntimeControlClient> {
  return await connectRuntimeControl({
    role: 'launcher',
    productVersion: productVersion(),
    readyDeadlineMs
  });
}

async function prepareRuntimeAssets(): Promise<void> {
  await mkdir(runtimeAssetsDirectory, { recursive: true });
  await writeFile(
    join(runtimeAssetsDirectory, 'index.html'),
    '<!doctype html><title>Debrute source development proxy</title>\n',
    'utf8'
  );
}

function spawnRuntime(options: RustRuntimeDevelopmentOptions): ChildProcess {
  mkdirSync(developmentDirectory, { recursive: true });
  if (process.platform === 'darwin') {
    const desktopEnvironment = options.desktopEntrypoint
      ? {
          DEBRUTE_DESKTOP_ENTRYPOINT: options.desktopEntrypoint,
          DEBRUTE_DESKTOP_ARGUMENTS_JSON: JSON.stringify(options.desktopArguments ?? [])
        }
      : {};
    const environment = {
      DEBRUTE_RUNTIME_WEB_ASSETS_DIR: runtimeAssetsDirectory,
      ...desktopEnvironment
    };
    const arguments_ = [
      '-g',
      '-n',
      '--stdout', runtimeLogPath,
      '--stderr', runtimeLogPath,
      ...Object.entries(environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
      runtimeApplication,
      '--args',
      '--stable-runtime-entrypoint',
      runtimeEntrypoint
    ];
    return spawn('/usr/bin/open', arguments_, {
      cwd: workspaceRoot,
      detached: process.env.DEBRUTE_DEV_STOP_RUNTIME_ON_EXIT !== '1',
      stdio: 'ignore'
    });
  }
  const log = openSync(runtimeLogPath, 'a', 0o600);
  const desktopEnvironment = options.desktopEntrypoint
    ? {
        DEBRUTE_DESKTOP_ENTRYPOINT: options.desktopEntrypoint,
        DEBRUTE_DESKTOP_ARGUMENTS_JSON: JSON.stringify(options.desktopArguments ?? [])
      }
    : {};
  try {
    return spawn(runtimeEntrypoint, ['--stable-runtime-entrypoint', runtimeEntrypoint], {
      cwd: workspaceRoot,
      detached: process.env.DEBRUTE_DEV_STOP_RUNTIME_ON_EXIT !== '1',
      stdio: ['ignore', log, log],
      env: {
        ...process.env,
        DEBRUTE_RUNTIME_WEB_ASSETS_DIR: runtimeAssetsDirectory,
        ...desktopEnvironment
      }
    });
  } finally {
    closeSync(log);
  }
}

async function signMacosRuntimeApplication(): Promise<void> {
  const child = spawn('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    runtimeApplication
  ], {
    cwd: workspaceRoot,
    stdio: 'inherit'
  });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(`Debrute Runtime development signing failed with code ${exitCode ?? 'unknown'}.`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
