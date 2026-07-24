import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  RuntimeControlError,
  connectRuntimeControl,
  type RuntimeControlClient
} from '@debrute/runtime-control-client';

const RUNTIME_READY_TIMEOUT_MS = 15_000;
const RUNTIME_CONNECT_INTERVAL_MS = 50;

interface DesktopRuntimeLaunchOptions {
  productVersion: string;
  runtimeEntrypoint: string;
  runtimeArguments: string[];
  webAssetsDirectory: string;
  runtimeLogPath: string;
  desktopEntrypoint: string;
  desktopArguments: string[];
  environment: NodeJS.ProcessEnv;
}

export async function connectOrLaunchDesktopRuntime(
  options: DesktopRuntimeLaunchOptions
): Promise<RuntimeControlClient> {
  const readyDeadlineMs = Date.now() + RUNTIME_READY_TIMEOUT_MS;
  try {
    const control = await connectDesktopLauncher(options.productVersion, readyDeadlineMs);
    await control.waitUntilReady();
    return control;
  } catch (error) {
    if (!(error instanceof RuntimeControlError) || error.code !== 'runtime_unavailable') {
      throw error;
    }
  }

  const child = spawnRuntime(options);
  let lastError: unknown;
  while (Date.now() < readyDeadlineMs) {
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Debrute Runtime exited during startup with code ${child.exitCode}.`);
    }
    try {
      const control = await connectDesktopLauncher(options.productVersion, readyDeadlineMs);
      await control.waitUntilReady();
      child.unref();
      return control;
    } catch (error) {
      lastError = error;
      if (error instanceof RuntimeControlError && error.code !== 'runtime_unavailable') {
        throw error;
      }
      await delay(RUNTIME_CONNECT_INTERVAL_MS);
    }
  }
  throw new RuntimeControlError(
    'runtime_ready_timeout',
    'Debrute Runtime did not become Ready before the absolute deadline.',
    { cause: lastError }
  );
}

async function connectDesktopLauncher(
  productVersion: string,
  readyDeadlineMs: number
): Promise<RuntimeControlClient> {
  return await connectRuntimeControl({
    role: 'launcher',
    productVersion,
    readyDeadlineMs
  });
}

function spawnRuntime(options: DesktopRuntimeLaunchOptions): ChildProcess {
  mkdirSync(dirname(options.runtimeLogPath), { recursive: true });
  const log = openSync(options.runtimeLogPath, 'a', 0o600);
  try {
    return spawn(options.runtimeEntrypoint, options.runtimeArguments, {
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...options.environment,
        DEBRUTE_RUNTIME_WEB_ASSETS_DIR: options.webAssetsDirectory,
        DEBRUTE_DESKTOP_ENTRYPOINT: options.desktopEntrypoint,
        DEBRUTE_DESKTOP_ARGUMENTS_JSON: JSON.stringify(options.desktopArguments)
      }
    });
  } finally {
    closeSync(log);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
