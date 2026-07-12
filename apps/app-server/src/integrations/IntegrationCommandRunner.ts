import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { IntegrationOperationDiagnostic, IntegrationProbeErrorKind } from './IntegrationCatalog.js';

export interface IntegrationCommandInput {
  file: string;
  args: string[];
  timeoutMs: number;
}

export interface IntegrationCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  diagnostic: IntegrationOperationDiagnostic;
}

export interface ProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  errorKind?: IntegrationProbeErrorKind;
}

export interface IntegrationProcessAdapter {
  resolveExecutable(
    name: string,
    envPath: string,
    platform: NodeJS.Platform,
    pathExt: string
  ): Promise<string | undefined>;
  runProbe(file: string, args: string[], timeoutMs: number): Promise<ProbeResult>;
  runCommand(input: IntegrationCommandInput): Promise<IntegrationCommandResult>;
}

const COMMAND_OUTPUT_CAPTURE_LIMIT = 65_536;
const DIAGNOSTIC_TAIL_LIMIT = 4096;

export async function resolveExecutable(name: string, envPath: string, platform: NodeJS.Platform, pathExt: string): Promise<string | undefined> {
  for (const dir of splitPath(envPath)) {
    for (const candidateName of executableCandidateNames(name, platform, pathExt)) {
      const candidate = join(dir, candidateName);
      if (await isExecutable(candidate, platform)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function runIntegrationCommand(commandToRun: IntegrationCommandInput): Promise<IntegrationCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(commandToRun.file, commandToRun.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      resolve({
        ok: false,
        stdout,
        stderr,
        diagnostic: {
          errorKind: 'timeout',
          ...(stdout ? { stdoutTail: tail(stdout) } : {}),
          ...(stderr ? { stderrTail: tail(stderr) } : {})
        }
      });
    }, commandToRun.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const message = stderr || error.message;
      resolve({
        ok: false,
        stdout,
        stderr: message,
        diagnostic: {
          errorKind: 'spawn_error',
          ...(stdout ? { stdoutTail: tail(stdout) } : {}),
          stderrTail: tail(message)
        }
      });
    });
    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const errorKind: IntegrationProbeErrorKind | undefined = exitCode === 0 ? undefined : 'nonzero_exit';
      resolve({
        ok: exitCode === 0,
        stdout,
        stderr,
        diagnostic: {
          ...(exitCode !== null ? { exitCode } : {}),
          ...(errorKind ? { errorKind } : {}),
          ...(stdout ? { stdoutTail: tail(stdout) } : {}),
          ...(stderr ? { stderrTail: tail(stderr) } : {})
        }
      });
    });
  });
}

export function runProbe(file: string, args: string[], timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, stdout, stderr, errorKind: 'timeout' });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = tail(stdout + chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = tail(stderr + chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr || error.message, errorKind: 'spawn_error' });
    });
    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: exitCode === 0,
        stdout,
        stderr,
        ...(exitCode !== null ? { exitCode } : {}),
        ...(exitCode === 0 ? {} : { errorKind: 'nonzero_exit' })
      });
    });
  });
}

export const nodeIntegrationProcessAdapter: IntegrationProcessAdapter = {
  resolveExecutable,
  runProbe,
  runCommand: runIntegrationCommand
};

export function tail(value: string, limit = DIAGNOSTIC_TAIL_LIMIT): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function splitPath(value: string): string[] {
  return value.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function executableCandidateNames(name: string, platform: NodeJS.Platform, pathExt: string): string[] {
  if (platform !== 'win32') {
    return [name];
  }
  const lowerName = name.toLowerCase();
  const extensions = pathExt.split(';').map((entry) => entry.trim()).filter(Boolean);
  if (extensions.some((extension) => lowerName.endsWith(extension.toLowerCase()))) {
    return [name];
  }
  return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function appendBounded(current: string, next: string, limit = COMMAND_OUTPUT_CAPTURE_LIMIT): string {
  return tail(current + next, limit);
}
