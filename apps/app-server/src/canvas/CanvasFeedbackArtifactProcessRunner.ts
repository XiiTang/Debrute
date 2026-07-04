import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CanvasFeedbackRenderCancelledError,
  type CanvasFeedbackRenderRunner
} from './CanvasFeedbackArtifactScheduler.js';
import type {
  CanvasFeedbackRenderJobInput,
  CanvasFeedbackRenderJobResult
} from './CanvasFeedbackArtifactWorkerProtocol.js';

export interface CanvasFeedbackArtifactProcessRunnerOptions {
  readonly workerPath?: string;
  readonly execArgv?: readonly string[];
}

export interface CanvasFeedbackRenderWorkerPathInput {
  readonly moduleUrl?: string | undefined;
  readonly moduleDirectory?: string | undefined;
}

export function createCanvasFeedbackArtifactProcessRunner(
  options: CanvasFeedbackArtifactProcessRunnerOptions = {}
): CanvasFeedbackRenderRunner {
  const workerPath = options.workerPath ?? workerEntryPath();
  const execArgv = options.execArgv ?? (workerPath.endsWith('.ts') ? process.execArgv : []);
  return {
    render(input, signal) {
      return runRenderWorker(input, signal, workerPath, execArgv);
    }
  };
}

export function resolveCanvasFeedbackRenderWorkerPath(input: CanvasFeedbackRenderWorkerPathInput): string {
  if (input.moduleUrl) {
    const extension = fileURLToPath(input.moduleUrl).endsWith('.ts') ? 'ts' : 'js';
    return fileURLToPath(new URL(`./CanvasFeedbackArtifactWorker.${extension}`, input.moduleUrl));
  }
  if (input.moduleDirectory) {
    return join(input.moduleDirectory, 'canvas-feedback-artifact-worker.cjs');
  }
  throw new Error('Canvas feedback render worker path cannot be resolved.');
}

function runRenderWorker(
  input: CanvasFeedbackRenderJobInput,
  signal: AbortSignal,
  workerPath: string,
  execArgv: readonly string[]
): Promise<CanvasFeedbackRenderJobResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...execArgv, workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      child.kill('SIGTERM');
    };
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      signal.removeEventListener('abort', abort);
      reject(cancelled ? new CanvasFeedbackRenderCancelledError() : error);
    });
    child.on('close', () => {
      signal.removeEventListener('abort', abort);
      if (cancelled) {
        reject(new CanvasFeedbackRenderCancelledError());
        return;
      }
      const line = stdout.trim();
      if (!line) {
        reject(new Error(`Canvas feedback render worker produced no result.${stderr ? ` ${stderr.trim()}` : ''}`));
        return;
      }
      try {
        const parsed = JSON.parse(line) as CanvasFeedbackRenderJobResult;
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin?.end(`${JSON.stringify(input)}\n`);
  });
}

function workerEntryPath(): string {
  return resolveCanvasFeedbackRenderWorkerPath({
    moduleUrl: typeof import.meta.url === 'string' && import.meta.url ? import.meta.url : undefined,
    moduleDirectory: typeof __dirname === 'string' ? __dirname : undefined
  });
}
