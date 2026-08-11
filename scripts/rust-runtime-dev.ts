import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RuntimeControlError,
  connectRuntimeControl,
  type RuntimeControlClient
} from '@debrute/runtime-control-client';
import {
  prepareNativeRasterPayload,
  validateNativeRasterPayload
} from './native-raster-payload.mjs';
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
const windowsRuntimeDirectory = join(developmentDirectory, 'windows-runtime');
const windowsRuntimeExecutable = join(windowsRuntimeDirectory, 'debrute-runtime.exe');
const windowsRuntimeAssemblyIdentityPath = join(
  developmentDirectory,
  'windows-runtime-assembly-identity.json'
);
const runtimeExecutable = process.platform === 'darwin'
  ? join(runtimeApplication, MACOS_RUNTIME_EXECUTABLE)
  : process.platform === 'win32' ? windowsRuntimeExecutable : runtimeBinary;
const runtimeEntrypoint = process.platform === 'darwin'
  ? join(developmentDirectory, 'debrute-runtime')
  : process.platform === 'win32' ? windowsRuntimeExecutable : runtimeBinary;
const runtimeAssetsDirectory = join(developmentDirectory, 'assets');
const runtimeLogPath = join(developmentDirectory, 'runtime.log');
const RUNTIME_READY_TIMEOUT_MS = 15_000;
const WINDOWS_RUNTIME_REPLACEMENT_TIMEOUT_MS = 5_000;
const WINDOWS_RUNTIME_REPLACEMENT_INITIAL_DELAY_MS = 50;
const WINDOWS_RUNTIME_REPLACEMENT_MAX_DELAY_MS = 250;
const windowsRuntimeReplacementRetryErrorCodes = new Set([
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'ENOTEMPTY',
  'EPERM'
]);

export interface RustRuntimeDevelopmentOptions {
  desktopEntrypoint?: string;
  desktopArguments?: string[];
  restartExisting?: boolean;
}

interface RuntimeExecutableAssemblyInput {
  compiledRuntimeIdentity: string;
  installedRuntimeIdentity: string | undefined;
  runtimeExecutableExists: boolean;
}

interface WindowsRuntimeAssemblyIdentity {
  schemaVersion: 3;
  compiledRuntimeIdentity: string;
  compiledRuntimeSha256: string;
  nativeRasterManifestSha256: string;
  nativeRasterRuntimeInventorySha256: string;
  runtimePayloadInventorySha256: string;
}

interface WindowsRuntimeAssemblyExpectation {
  compiledRuntimeIdentity: string;
  compiledRuntimeSha256: string;
  nativeRasterManifestSha256: string;
  nativeRasterRuntimeInventorySha256: string;
  runtimePayloadInventorySha256: string;
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
  const nativeRasterIdentity = await directoryInventorySha256(
    join(workspaceRoot, 'target/debug/native-raster')
  );
  const runtimeAssemblyIdentity = [
    compiledRuntimeIdentity,
    nativeRasterIdentity
  ].join(':');
  if (process.platform === 'darwin' && macosRuntimeApplicationNeedsAssembly({
    compiledRuntimeIdentity: runtimeAssemblyIdentity,
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
    await writeFile(runtimeApplicationBinaryIdentityPath, `${runtimeAssemblyIdentity}\n`, 'utf8');
  }
  return rebuilt;
}

export function macosRuntimeApplicationNeedsAssembly(input: {
  compiledRuntimeIdentity: string;
  installedRuntimeIdentity: string | undefined;
  runtimeExecutableExists: boolean;
}): boolean {
  return runtimeExecutableNeedsAssembly(input);
}

export function runtimeExecutableNeedsAssembly(input: RuntimeExecutableAssemblyInput): boolean {
  return !input.runtimeExecutableExists
    || input.installedRuntimeIdentity !== input.compiledRuntimeIdentity;
}

export function windowsRuntimeDirectoryNeedsAssembly(input: {
  expectation: WindowsRuntimeAssemblyExpectation;
  installedIdentity: WindowsRuntimeAssemblyIdentity | undefined;
  installedRuntimeSha256: string | undefined;
  installedRuntimeInventorySha256: string | undefined;
}): boolean {
  return runtimeExecutableNeedsAssembly({
    compiledRuntimeIdentity: input.expectation.compiledRuntimeIdentity,
    installedRuntimeIdentity: input.installedIdentity?.compiledRuntimeIdentity,
    runtimeExecutableExists: input.installedRuntimeSha256 !== undefined
  })
    || input.installedIdentity?.schemaVersion !== 3
    || input.installedIdentity.compiledRuntimeSha256 !== input.expectation.compiledRuntimeSha256
    || input.installedRuntimeSha256 !== input.expectation.compiledRuntimeSha256
    || input.installedIdentity.nativeRasterManifestSha256
      !== input.expectation.nativeRasterManifestSha256
    || input.installedIdentity.nativeRasterRuntimeInventorySha256
      !== input.expectation.nativeRasterRuntimeInventorySha256
    || input.installedIdentity.runtimePayloadInventorySha256
      !== input.expectation.runtimePayloadInventorySha256
    || input.installedRuntimeInventorySha256
      !== input.expectation.runtimePayloadInventorySha256;
}

export async function ensureRustRuntime(
  options: RustRuntimeDevelopmentOptions = {}
): Promise<RuntimeControlClient> {
  const readyDeadlineMs = Date.now() + RUNTIME_READY_TIMEOUT_MS;
  try {
    const existing = await connectLauncher(readyDeadlineMs);
    const inspection = await existing.inspect();
    const currentExecutableIdentity = runtimeBinaryIdentity();
    const windowsRuntimeIsCurrent = process.platform !== 'win32'
      || await windowsRuntimeDirectoryIsCurrent();
    if (
      !options.restartExisting
      && windowsRuntimeIsCurrent
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
  await prepareWindowsRuntimeDirectory();
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

async function windowsRuntimeDirectoryIsCurrent(): Promise<boolean> {
  const expectation = await windowsRuntimeAssemblyExpectation();
  if (expectation === undefined) {
    return false;
  }
  return !windowsRuntimeDirectoryNeedsAssembly({
    expectation,
    installedIdentity: optionalWindowsRuntimeAssemblyIdentity(),
    installedRuntimeSha256: await optionalFileSha256(windowsRuntimeExecutable),
    installedRuntimeInventorySha256: await windowsRuntimeDirectoryInventorySha256(
      windowsRuntimeDirectory
    )
  });
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

export function parseWindowsRuntimeAssemblyIdentity(
  text: string
): WindowsRuntimeAssemblyIdentity | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    'compiledRuntimeIdentity',
    'compiledRuntimeSha256',
    'nativeRasterManifestSha256',
    'nativeRasterRuntimeInventorySha256',
    'runtimePayloadInventorySha256',
    'schemaVersion'
  ].sort();
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])) {
    return undefined;
  }
  return record.schemaVersion === 3
    && typeof record.compiledRuntimeIdentity === 'string'
    && record.compiledRuntimeIdentity.length > 0
    && isSha256(record.compiledRuntimeSha256)
    && isSha256(record.nativeRasterManifestSha256)
    && isSha256(record.nativeRasterRuntimeInventorySha256)
    && isSha256(record.runtimePayloadInventorySha256)
    ? record as unknown as WindowsRuntimeAssemblyIdentity
    : undefined;
}

function optionalWindowsRuntimeAssemblyIdentity(): WindowsRuntimeAssemblyIdentity | undefined {
  const text = optionalFileText(windowsRuntimeAssemblyIdentityPath);
  return text === undefined ? undefined : parseWindowsRuntimeAssemblyIdentity(text);
}

async function optionalFileSha256(path: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(path));
  } catch {
    return undefined;
  }
}

export async function windowsRuntimeDirectoryInventorySha256(
  directory: string
): Promise<string | undefined> {
  try {
    const inventory = await directoryInventory(directory, '', new Set(['debrute-runtime.exe']));
    inventory.sort((left, right) => compareFileNames(left.name, right.name));
    return sha256(JSON.stringify(inventory));
  } catch {
    return undefined;
  }
}

export function isWindowsRuntimeReplacementRetryableError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && windowsRuntimeReplacementRetryErrorCodes.has(error.code);
}

export async function retryWindowsRuntimeReplacementOperation(
  operationName: string,
  operation: () => Promise<void>,
  deadlineMs: number
): Promise<void> {
  let retryDelayMs = WINDOWS_RUNTIME_REPLACEMENT_INITIAL_DELAY_MS;
  for (;;) {
    try {
      await operation();
      return;
    } catch (error) {
      if (!isWindowsRuntimeReplacementRetryableError(error)) {
        throw error;
      }
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Windows Runtime development assembly could not ${operationName} before locked files were released.`,
          { cause: error }
        );
      }
      await new Promise((resolveDelay) => setTimeout(
        resolveDelay,
        Math.min(retryDelayMs, remainingMs)
      ));
      retryDelayMs = Math.min(
        retryDelayMs * 2,
        WINDOWS_RUNTIME_REPLACEMENT_MAX_DELAY_MS
      );
    }
  }
}

export async function stopRustRuntime(control: RuntimeControlClient): Promise<void> {
  let runtimeLossObserved = false;
  let removeRuntimeLost = () => undefined;
  const stopped = new Promise<void>((resolveStopped) => {
    removeRuntimeLost = control.onRuntimeLost(() => {
      runtimeLossObserved = true;
      resolveStopped();
    });
  });
  try {
    let response: Awaited<ReturnType<RuntimeControlClient['quitProduct']>>;
    try {
      response = await control.quitProduct();
    } catch (error) {
      if (
        runtimeLossObserved
        && error instanceof RuntimeControlError
        && error.code === 'runtime_lost'
      ) {
        return;
      }
      throw error;
    }
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
  } finally {
    removeRuntimeLost();
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

async function prepareWindowsRuntimeDirectory(): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  const expectation = await windowsRuntimeAssemblyExpectation();
  if (expectation === undefined) {
    throw new Error('Debrute Runtime build is unavailable for Windows development assembly.');
  }
  if (!windowsRuntimeDirectoryNeedsAssembly({
    expectation,
    installedIdentity: optionalWindowsRuntimeAssemblyIdentity(),
    installedRuntimeSha256: await optionalFileSha256(windowsRuntimeExecutable),
    installedRuntimeInventorySha256: await windowsRuntimeDirectoryInventorySha256(
      windowsRuntimeDirectory
    )
  })) {
    return;
  }

  const nativeRasterRoot = join(workspaceRoot, 'target/debug/native-raster');
  const nativeRasterFiles = await readdir(nativeRasterRoot, { withFileTypes: true });
  if (nativeRasterFiles.length === 0
    || nativeRasterFiles.some((entry) => !entry.isFile())
    || !nativeRasterFiles.some((entry) => entry.name.toLowerCase().endsWith('.dll'))) {
    throw new Error(`Windows Runtime native raster payload must be a non-empty flat DLL inventory: ${nativeRasterRoot}`);
  }

  const stagingDirectory = `${windowsRuntimeDirectory}.staging-${process.pid}`;
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });
  try {
    await cp(runtimeBinary, join(stagingDirectory, 'debrute-runtime.exe'), { dereference: true });
    for (const entry of nativeRasterFiles) {
      await cp(
        join(nativeRasterRoot, entry.name),
        join(stagingDirectory, entry.name),
        { dereference: true }
      );
    }
    const stagedRuntimeSha256 = await optionalFileSha256(
      join(stagingDirectory, 'debrute-runtime.exe')
    );
    const stagedRuntimeInventorySha256 = await windowsRuntimeDirectoryInventorySha256(
      stagingDirectory
    );
    if (stagedRuntimeSha256 !== expectation.compiledRuntimeSha256
      || stagedRuntimeInventorySha256 !== expectation.runtimePayloadInventorySha256) {
      throw new Error('Windows Runtime development assembly failed closed inventory validation.');
    }
    const replacementDeadlineMs = Date.now() + WINDOWS_RUNTIME_REPLACEMENT_TIMEOUT_MS;
    await retryWindowsRuntimeReplacementOperation(
      'remove the previous Runtime directory',
      () => rm(windowsRuntimeDirectory, { recursive: true, force: true }),
      replacementDeadlineMs
    );
    await retryWindowsRuntimeReplacementOperation(
      'activate the staged Runtime directory',
      () => rename(stagingDirectory, windowsRuntimeDirectory),
      replacementDeadlineMs
    );
    await writeFile(
      windowsRuntimeAssemblyIdentityPath,
      `${JSON.stringify({ schemaVersion: 3, ...expectation }, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function windowsRuntimeAssemblyExpectation(): Promise<
  WindowsRuntimeAssemblyExpectation | undefined
> {
  const compiledRuntimeIdentity = fileIdentity(runtimeBinary);
  const compiledRuntimeSha256 = await optionalFileSha256(runtimeBinary);
  if (compiledRuntimeIdentity === undefined || compiledRuntimeSha256 === undefined) {
    return undefined;
  }
  const payload = await validateNativeRasterPayload();
  const manifestBytes = await readFile(join(payload.root, 'manifest.json'));
  const inventory = payload.manifest.runtimeFiles
    .map((file: { path: string; sizeBytes: number; sha256: string }) => ({
      name: file.path.slice('runtime/'.length),
      sizeBytes: file.sizeBytes,
      sha256: file.sha256
    }))
    .sort((left: { name: string }, right: { name: string }) => (
      compareFileNames(left.name, right.name)
    ));
  const runtimePayloadInventory = inventory;
  return {
    compiledRuntimeIdentity,
    compiledRuntimeSha256,
    nativeRasterManifestSha256: sha256(manifestBytes),
    nativeRasterRuntimeInventorySha256: sha256(JSON.stringify(inventory)),
    runtimePayloadInventorySha256: sha256(JSON.stringify(runtimePayloadInventory))
  };
}

async function directoryInventorySha256(directory: string): Promise<string> {
  return sha256(JSON.stringify(await directoryInventory(directory)));
}

async function directoryInventory(
  directory: string,
  prefix = '',
  excludedRootNames = new Set<string>()
): Promise<Array<{ name: string; sizeBytes: number; sha256: string }>> {
  const inventory: Array<{ name: string; sizeBytes: number; sha256: string }> = [];
  async function collect(current: string, relative: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && excludedRootNames.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await collect(path, name);
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        inventory.push({
          name: prefix ? `${prefix}/${name}` : name,
          sizeBytes: bytes.byteLength,
          sha256: sha256(bytes)
        });
      } else {
        throw new Error(`Runtime development payload contains an unsupported entry: ${path}`);
      }
    }
  }
  await collect(directory, '');
  return inventory.sort((left, right) => compareFileNames(left.name, right.name));
}

function sha256(value: NodeJS.ArrayBufferView | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function compareFileNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
      windowsHide: process.platform === 'win32',
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
