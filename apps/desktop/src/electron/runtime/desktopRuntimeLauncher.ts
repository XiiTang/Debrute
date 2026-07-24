import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  RuntimeControlError,
  connectRuntimeControl,
  type RuntimeControlClient
} from '@debrute/runtime-control-client';

const RUNTIME_STARTUP_TIMEOUT_MS = 10_000;
const RUNTIME_CONNECT_INTERVAL_MS = 50;

export interface DesktopRuntimeLaunchOptions {
  productVersion: string;
  runtimeEntrypoint: string;
  runtimeArguments?: string[];
  webAssetsDirectory: string;
  runtimeLogPath: string;
  desktopEntrypoint: string;
  desktopArguments?: string[];
  environment?: NodeJS.ProcessEnv;
}

export async function connectOrLaunchDesktopRuntime(
  options: DesktopRuntimeLaunchOptions
): Promise<RuntimeControlClient> {
  try {
    return await connectDesktopLauncher(options.productVersion);
  } catch (error) {
    if (!(error instanceof RuntimeControlError) || error.code !== 'runtime_unavailable') {
      throw error;
    }
  }

  const child = spawnRuntime(options);
  const deadline = Date.now() + RUNTIME_STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Debrute Runtime exited during startup with code ${child.exitCode}.`);
    }
    try {
      const control = await connectDesktopLauncher(options.productVersion);
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
  throw new Error('Debrute Runtime did not publish its Control endpoint in time.', {
    cause: lastError
  });
}

async function connectDesktopLauncher(productVersion: string): Promise<RuntimeControlClient> {
  return await connectRuntimeControl({
    role: 'launcher',
    productVersion,
    handshakeTimeoutMs: 5_000
  });
}

function spawnRuntime(options: DesktopRuntimeLaunchOptions): ChildProcess {
  mkdirSync(dirname(options.runtimeLogPath), { recursive: true });
  const log = openSync(options.runtimeLogPath, 'a', 0o600);
  try {
    return spawn(options.runtimeEntrypoint, options.runtimeArguments ?? [], {
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...options.environment,
        DEBRUTE_RUNTIME_WEB_ASSETS_DIR: options.webAssetsDirectory,
        DEBRUTE_RUNTIME_STABLE_ENTRYPOINT: options.runtimeEntrypoint,
        DEBRUTE_DESKTOP_ENTRYPOINT: options.desktopEntrypoint,
        DEBRUTE_DESKTOP_ARGUMENTS_JSON: JSON.stringify(options.desktopArguments ?? [])
      }
    });
  } finally {
    closeSync(log);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
