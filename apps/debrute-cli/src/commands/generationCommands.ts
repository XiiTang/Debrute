import { resolve } from 'node:path';
import type { RunImageModelBatchInput } from '@debrute/app-protocol';
import type { DebruteAppServer } from '@debrute/app-server';
import { cliError, normalizeServiceErrorCode, projectLoadCliError } from '../errors/cliErrors.js';
import type { ParsedDebruteArgs } from '../parser/parseDebruteArgs.js';
import { parseJsonObject } from '../parser/jsonInput.js';
import type { AgentNamedRecord, DebruteAgentResult } from '../output/renderAgentRecord.js';
import { primitiveOutputFields } from '../output/fieldEncoding.js';

export async function runGenerationCommand(args: ParsedDebruteArgs, server: DebruteAppServer): Promise<DebruteAgentResult> {
  if (!args.projectRoot) {
    throw cliError('missing_argument', `${args.command} requires <project>.`);
  }
  try {
    await server.openProject(args.projectRoot, { initializeIfMissing: false, createDefaultCanvas: false, watchFiles: false });
  } catch (error) {
    throw projectLoadCliError(error, args.projectRoot);
  }

  if (args.command === 'generate.image') {
    return capabilityResult(args.command, await server.runImageModelRequestForCli(requestInput(args)));
  }

  if (args.command === 'generate.video') {
    return capabilityResult(args.command, await server.runVideoModelRequestForCli(requestInput(args)));
  }

  if (args.command === 'generate.image-batch') {
    const summary = await server.runImageModelBatch(imageBatchInputFromArgs(args));
    if (summary.failedCount > 0) {
      process.exitCode = 1;
    }
    return {
      status: 'ok',
      command: args.command,
      fields: {
        total: summary.total,
        ok: summary.okCount,
        failed: summary.failedCount,
        skipped: summary.skippedCount,
        log: summary.logPath,
        summary: summary.summaryPath,
        concurrency: summary.concurrency,
        retries: summary.retries,
        duration_seconds: summary.durationSeconds
      }
    };
  }

  throw cliError('invalid_command', `Unknown Debrute CLI command: ${args.command}`);
}

function requestInput(args: ParsedDebruteArgs): { model: string; arguments: Record<string, unknown>; timeoutMs?: number } {
  const input = parseJsonObject(args.options['input-json']!, '--input-json');
  if (typeof input.model !== 'string' || !input.model.trim()) {
    throw cliError('invalid_input', '--input-json requires string field "model".');
  }
  if (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
    throw cliError('invalid_input', '--input-json requires object field "arguments".');
  }
  return {
    model: input.model,
    arguments: input.arguments as Record<string, unknown>,
    ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {})
  };
}

function imageBatchInputFromArgs(args: ParsedDebruteArgs): RunImageModelBatchInput {
  const timeoutMs = optionalPositiveIntegerOption(args, 'timeout-ms');
  return {
    source: args.options.manifest
      ? { kind: 'manifest', path: resolve(args.options.manifest) }
      : { kind: 'jsonl', path: resolve(args.options['input-jsonl']!) },
    concurrency: positiveIntegerOption(args, 'concurrency', 4),
    retries: nonNegativeIntegerOption(args, 'retries', 0),
    ...(timeoutMs ? { timeoutMs } : {}),
    logPath: resolve(args.options.log!),
    ...(args.options.summary ? { summaryPath: resolve(args.options.summary) } : {})
  };
}

function capabilityResult(command: string, result: Awaited<ReturnType<DebruteAppServer['runImageModelRequestForCli']>>): DebruteAgentResult {
  if (result.status === 'error') {
    return {
      status: 'error',
      command,
      code: normalizeServiceErrorCode(result.error.code),
      message: result.error.message,
      fields: primitiveOutputFields(result.outputs ?? {})
    };
  }
  return {
    status: 'ok',
    command,
    records: artifactRecords(result.artifacts ?? []),
    fields: {
      ...primitiveOutputFields(result.outputs),
      artifacts: result.artifacts?.length ?? 0
    }
  };
}

function artifactRecords(artifacts: NonNullable<Awaited<ReturnType<DebruteAppServer['runImageModelRequestForCli']>>['artifacts']>): AgentNamedRecord[] {
  return artifacts.map((artifact) => ({
    name: 'artifact',
    fields: {
      id: artifact.artifactId,
      path: artifact.projectRelativePath,
      title: artifact.title,
      mime: artifact.mimeType,
      width: artifact.width,
      height: artifact.height
    }
  }));
}

function positiveIntegerOption(args: ParsedDebruteArgs, key: string, fallback: number): number {
  return optionalPositiveIntegerOption(args, key) ?? fallback;
}

function optionalPositiveIntegerOption(args: ParsedDebruteArgs, key: string): number | undefined {
  const raw = args.options[key];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw cliError('invalid_input', `--${key} must be a positive integer.`);
  }
  return value;
}

function nonNegativeIntegerOption(args: ParsedDebruteArgs, key: string, fallback: number): number {
  const raw = args.options[key];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw cliError('invalid_input', `--${key} must be a non-negative integer.`);
  }
  return value;
}
