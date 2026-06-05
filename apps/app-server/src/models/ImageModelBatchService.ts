import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  ImageModelBatchRequest,
  ImageModelBatchSource,
  ImageModelBatchSummary,
  RunImageModelBatchInput
} from '@debrute/app-protocol';

interface ImageModelBatchPayload {
  model?: unknown;
  arguments?: unknown;
  timeoutMs?: unknown;
  outputPath?: unknown;
}

export type ImageModelBatchResult =
  | {
      status: 'skipped';
      reason: 'output_exists';
      index: number;
      model: string;
      outputPath?: string;
    }
  | {
      status: 'ok';
      index: number;
      model: string;
      attempt: number;
      durationSeconds: number;
      outputPath?: string;
      artifacts?: unknown[];
    }
  | {
      status: 'failed';
      index: number;
      model: string;
      attempt: number;
      durationSeconds: number;
      outputPath?: string;
      error: unknown;
    };

export interface ImageModelBatchRunnerDependencies {
  projectFileExistsWithContent(input: { projectRelativePath: string }): Promise<boolean>;
  executeImageModelRequest(input: {
    model: string;
    arguments: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<ImageModelBatchExecutionResult>;
}

export type ImageModelBatchExecutionResult =
  | { status: 'ok'; artifacts?: unknown[] }
  | { status: 'failed'; error: unknown };

export async function loadImageModelBatchRequests(source: ImageModelBatchSource): Promise<ImageModelBatchRequest[]> {
  if (source.kind === 'requests') {
    return source.requests.map((request) => imageModelBatchRequestFromPayload(request));
  }
  if (source.kind === 'manifest') {
    return imageModelBatchRequestsFromManifest(parseJsonObject(await readFile(resolve(source.path), 'utf8'), '--manifest'));
  }
  return imageModelBatchRequestsFromJsonl(await readFile(resolve(source.path), 'utf8'));
}

export async function runImageModelBatch(
  input: RunImageModelBatchInput,
  dependencies: ImageModelBatchRunnerDependencies
): Promise<ImageModelBatchSummary> {
  validateBatchInput(input);
  const requests = await loadImageModelBatchRequests(input.source);
  if (requests.length === 0) {
    throw imageModelBatchError('invalid_input', 'Image model batch must include at least one request.');
  }

  const absoluteLogPath = resolve(input.logPath);
  const absoluteSummaryPath = input.summaryPath ? resolve(input.summaryPath) : undefined;
  const writer = await createBatchResultWriter(absoluteLogPath);
  const started = Date.now();
  const results: ImageModelBatchResult[] = [];
  let nextIndex = 0;

  const writeFinalResult = async (result: ImageModelBatchResult): Promise<void> => {
    results.push(result);
    await writer.write(result);
  };

  try {
    await Promise.all(Array.from({ length: Math.min(input.concurrency, requests.length) }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        const request = requests[index];
        if (!request) {
          return;
        }
        await writeFinalResult(await runOneImageModelBatchItem({
          request,
          index: index + 1,
          retries: input.retries,
          dependencies,
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {})
        }));
      }
    }));
  } finally {
    await writer.close();
  }

  const summary: ImageModelBatchSummary = {
    total: requests.length,
    okCount: results.filter((result) => result.status === 'ok').length,
    skippedCount: results.filter((result) => result.status === 'skipped').length,
    failedCount: results.filter((result) => result.status === 'failed').length,
    durationSeconds: roundSeconds(Date.now() - started),
    concurrency: input.concurrency,
    retries: input.retries,
    logPath: absoluteLogPath,
    ...(absoluteSummaryPath ? { summaryPath: absoluteSummaryPath } : {})
  };
  if (absoluteSummaryPath) {
    await mkdir(dirname(absoluteSummaryPath), { recursive: true });
    await writeFile(absoluteSummaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }
  return summary;
}

export function imageModelBatchRequestsFromManifest(manifest: Record<string, unknown>): ImageModelBatchRequest[] {
  return arrayValue(manifest.requests, 'manifest.requests')
    .map((item, index) => imageModelBatchRequestFromPayload(recordValue(item, `manifest.requests[${index}]`)));
}

export function imageModelBatchRequestsFromJsonl(content: string): ImageModelBatchRequest[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => imageModelBatchRequestFromPayload(parseJsonObject(line, `--input-jsonl line ${index + 1}`)));
}

export function imageModelBatchError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function imageModelBatchRequestFromPayload(payload: ImageModelBatchPayload): ImageModelBatchRequest {
  const model = stringValue(payload.model);
  if (!model) {
    throw imageModelBatchError('invalid_input', 'Image model batch request must include string field "model".');
  }
  const requestArguments = recordValue(payload.arguments, 'request.arguments');
  const timeoutMs = imageModelBatchRequestTimeoutMs(payload.timeoutMs);
  const outputPath = stringValue(requestArguments.output_path) ?? stringValue(payload.outputPath);
  return {
    model,
    arguments: requestArguments,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(outputPath ? { outputPath } : {})
  };
}

async function runOneImageModelBatchItem(input: {
  request: ImageModelBatchRequest;
  index: number;
  retries: number;
  timeoutMs?: number;
  dependencies: ImageModelBatchRunnerDependencies;
}): Promise<ImageModelBatchResult> {
  const base = imageModelBatchResultBase(input.request, input.index);
  if (input.request.outputPath && await input.dependencies.projectFileExistsWithContent({ projectRelativePath: input.request.outputPath })) {
    return { ...base, status: 'skipped', reason: 'output_exists' };
  }

  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    const result = await input.dependencies.executeImageModelRequest({
      model: input.request.model,
      arguments: input.request.arguments,
      ...(input.timeoutMs ?? input.request.timeoutMs ? { timeoutMs: input.timeoutMs ?? input.request.timeoutMs } : {})
    });
    const durationSeconds = roundSeconds(Date.now() - started);
    if (result.status === 'ok') {
      return {
        ...base,
        status: 'ok',
        attempt,
        durationSeconds,
        ...(result.artifacts ? { artifacts: result.artifacts } : {})
      };
    }
    if (attempt > input.retries) {
      return {
        ...base,
        status: 'failed',
        attempt,
        durationSeconds,
        error: result.error
      };
    }
    await sleep(100 * attempt);
  }
}

function validateBatchInput(input: RunImageModelBatchInput): void {
  if (!input.logPath || typeof input.logPath !== 'string' || !input.logPath.trim()) {
    throw imageModelBatchError('invalid_input', 'Image model batch requires --log.');
  }
  if (!Number.isInteger(input.concurrency) || input.concurrency <= 0) {
    throw imageModelBatchError('invalid_input', 'Image model batch --concurrency must be a positive integer.');
  }
  if (!Number.isInteger(input.retries) || input.retries < 0) {
    throw imageModelBatchError('invalid_input', 'Image model batch --retries must be a non-negative integer.');
  }
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0)) {
    throw imageModelBatchError('invalid_input', 'Image model batch --timeout-ms must be a positive integer.');
  }
}

function imageModelBatchResultBase(request: ImageModelBatchRequest, index: number) {
  return {
    index,
    model: request.model,
    ...(request.outputPath ? { outputPath: request.outputPath } : {})
  };
}

async function createBatchResultWriter(logPath: string): Promise<{
  write(result: ImageModelBatchResult): Promise<void>;
  close(): Promise<void>;
}> {
  await mkdir(dirname(logPath), { recursive: true });
  const stream = createWriteStream(logPath, { flags: 'w' });
  return {
    async write(result) {
      await writeJsonLine(stream, result);
    },
    async close() {
      await closeWriteStream(stream);
    }
  };
}

async function writeJsonLine(stream: WriteStream, value: unknown): Promise<void> {
  if (!stream.write(`${JSON.stringify(value)}\n`)) {
    await once(stream, 'drain');
  }
}

async function closeWriteStream(stream: WriteStream): Promise<void> {
  if (stream.closed) {
    return;
  }
  stream.end();
  await once(stream, 'finish');
}

function roundSeconds(milliseconds: number): number {
  return Math.round(milliseconds / 10) / 100;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseJsonObject(content: string, label: string): Record<string, unknown> {
  try {
    return recordValue(JSON.parse(content), label);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw imageModelBatchError('invalid_input', `${label} must be valid JSON.`);
    }
    throw error;
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw imageModelBatchError('invalid_input', `${label} must be a JSON object.`);
  }
  return value;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw imageModelBatchError('invalid_input', `${label} must be an array.`);
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function imageModelBatchRequestTimeoutMs(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw imageModelBatchError('invalid_input', 'Image model batch request timeoutMs must be a positive integer.');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
