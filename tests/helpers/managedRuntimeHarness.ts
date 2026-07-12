import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import {
  portFromUrl,
  readWorkbenchRuntimeState,
  resolveWorkbenchRuntimePaths,
  terminateManagedWorkbenchRuntime,
  type WorkbenchRuntimePaths,
  type WorkbenchRuntimeState
} from '@debrute/workbench-runtime';
import {
  assertPortCanRebind,
  createIsolatedDirectory,
  isProcessAlive,
  waitForCondition
} from './testPaths.js';

const WORKSPACE_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX_CLI_PATH = resolve(WORKSPACE_ROOT, 'node_modules/tsx/dist/cli.mjs');
const DEBRUTE_CLI_PATH = resolve(WORKSPACE_ROOT, 'apps/debrute-cli/src/index.ts');
const LOG_TAIL_LIMIT = 4_000;

export class ManagedRuntimeHarness implements AsyncDisposable {
  readonly homePath: string;
  readonly paths: WorkbenchRuntimePaths;
  private state: WorkbenchRuntimeState | undefined;
  private terminated = false;
  private disposed = false;

  private constructor(homePath: string) {
    this.homePath = homePath;
    this.paths = resolveWorkbenchRuntimePaths(resolve(homePath, '.debrute'));
  }

  static async create(): Promise<ManagedRuntimeHarness> {
    const harness = new ManagedRuntimeHarness(await createIsolatedDirectory('debrute-system-home-'));
    if (shouldKeepFailedRuntimeHome(process.env)) {
      onTestFinished(async ({ task }) => {
        if (task.result?.state === 'fail') {
          process.stderr.write(`Preserved failed runtime test home: ${harness.homePath}\n`);
          return;
        }
        await rm(harness.homePath, { recursive: true, force: true });
      });
    }
    return harness;
  }

  async start(): Promise<WorkbenchRuntimeState> {
    if (this.terminated || this.disposed) {
      throw new Error('Managed runtime harness has already terminated.');
    }
    await this.runCli(['workbench', 'start']);
    const nextState = await readWorkbenchRuntimeState(this.paths.statePath);
    if (!nextState) {
      throw new Error(`Managed runtime did not publish state: ${this.paths.statePath}`);
    }
    if (this.state && (
      nextState.daemonPid !== this.state.daemonPid
      || nextState.webPid !== this.state.webPid
    )) {
      throw new Error('Managed runtime reuse replaced the harness-owned processes.');
    }
    this.state = nextState;
    return nextState;
  }

  async runCli(args: string[]): Promise<string[]> {
    if (this.disposed) {
      throw new Error('Managed runtime harness has already been disposed.');
    }
    const result = await runChildProcess(process.execPath, [TSX_CLI_PATH, DEBRUTE_CLI_PATH, ...args], {
      ...process.env,
      HOME: this.homePath,
      USERPROFILE: this.homePath
    });
    if (result.exitCode !== 0) {
      throw new Error([
        `Debrute CLI exited with code ${result.exitCode}: ${args.join(' ')}`,
        boundedText('stdout', result.stdout),
        boundedText('stderr', result.stderr)
      ].join('\n'));
    }
    return result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  }

  async terminate(): Promise<void> {
    if (this.terminated) {
      return;
    }
    const state = this.state ?? await readWorkbenchRuntimeState(this.paths.statePath);
    if (!state) {
      this.terminated = true;
      return;
    }
    this.state = state;
    await terminateManagedWorkbenchRuntime(state);
    await this.verifyStopped(state);
    this.terminated = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    let primaryFailure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      await this.terminate();
    } catch (error) {
      primaryFailure = error;
      try {
        await this.forceStopRecordedProcesses();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }

    let logTails: string | undefined;
    if (primaryFailure !== undefined) {
      try {
        logTails = await this.readLogTails();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    const deferHomeDisposition = shouldKeepFailedRuntimeHome(process.env);
    if (!deferHomeDisposition) {
      try {
        await rm(this.homePath, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }

    if (primaryFailure !== undefined) {
      const message = [
        errorMessage(primaryFailure),
        logTails,
        deferHomeDisposition ? `preserved test home: ${this.homePath}` : undefined,
        ...cleanupFailures.map((failure) => `cleanup: ${errorMessage(failure)}`)
      ].filter((part): part is string => Boolean(part)).join('\n');
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        message,
        { cause: primaryFailure }
      );
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'Managed runtime harness cleanup failed.');
    }
  }

  private async verifyStopped(state: WorkbenchRuntimeState): Promise<void> {
    for (const pid of recordedPids(state)) {
      await waitForCondition(`managed runtime pid ${pid} to exit`, () => !isProcessAlive(pid));
    }
    for (const port of recordedPorts(state)) {
      await assertPortCanRebind(port);
    }
  }

  private async forceStopRecordedProcesses(): Promise<void> {
    const state = this.state ?? await readWorkbenchRuntimeState(this.paths.statePath);
    if (!state) {
      return;
    }
    const failures: unknown[] = [];
    for (const pid of recordedPids(state)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (!isMissingProcessError(error)) {
          failures.push(error);
        }
      }
    }
    try {
      await this.verifyStopped(state);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Forced managed runtime cleanup failed.');
    }
  }

  private async readLogTails(): Promise<string> {
    const [daemon, web] = await Promise.all([
      readTail(this.paths.daemonLogPath),
      readTail(this.paths.webLogPath)
    ]);
    return `${boundedText('daemon log', daemon)}\n${boundedText('web log', web)}`;
  }
}

async function runChildProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: WORKSPACE_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', resolveExit);
  });
  return { exitCode, stdout, stderr };
}

function recordedPids(state: WorkbenchRuntimeState): number[] {
  return [...new Set([
    state.daemonPid,
    ...(state.webPid === undefined ? [] : [state.webPid])
  ])];
}

function recordedPorts(state: WorkbenchRuntimeState): number[] {
  const daemonPort = portFromUrl(state.daemonUrl);
  const webPort = portFromUrl(state.webUrl);
  if (daemonPort === undefined || webPort === undefined) {
    throw new Error('Managed runtime state contains an invalid loopback port.');
  }
  return [...new Set([daemonPort, webPort])];
}

async function readTail(path: string): Promise<string> {
  try {
    const content = await readFile(path, 'utf8');
    return content.slice(-LOG_TAIL_LIMIT);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return '(not created)';
    }
    throw error;
  }
}

function boundedText(label: string, content: string): string {
  return `${label}:\n${content.slice(-LOG_TAIL_LIMIT)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingProcessError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ESRCH';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}

export function shouldKeepFailedRuntimeHome(env: NodeJS.ProcessEnv): boolean {
  return env.DEBRUTE_TEST_KEEP_TEMP === '1';
}
