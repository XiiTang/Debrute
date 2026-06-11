#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  DebruteCliError,
  cliError,
  exitCodeForCliError,
  isDebruteCliError,
  messageFromUnknown,
  normalizeServiceErrorCode,
  primitiveErrorFields
} from './errors/cliErrors.js';
import { runGenerationCommand } from './commands/generationCommands.js';
import { runWorkbenchCommand } from './commands/workbenchCommands.js';
import { parseDebruteArgs, commandNameFromArgv, type ParsedDebruteArgs } from './parser/parseDebruteArgs.js';
import { runProjectCommand } from './commands/projectCommands.js';
import { renderAgentRecord, type DebruteAgentResult } from './output/renderAgentRecord.js';
import { runRuntimeCommand } from './commands/runtimeCommands.js';
import { createCliSkillsRuntime, resolveCliDebruteVersion } from './runtime/createCliSkillsRuntime.js';
import { configurePackagedNodeModules } from './runtime/packagedNodeModules.js';
import { INTERNAL_WORKBENCH_RUNTIME_CHILD_COMMAND } from './workbench/workbenchRuntimeChildEntrypoint.js';

export async function runCli(argv: string[], output: (text: string) => void = console.log): Promise<void> {
  process.exitCode = undefined;
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    output(await resolveCliDebruteVersion());
    return;
  }
  let parsed: ParsedDebruteArgs | undefined;
  try {
    parsed = parseDebruteArgs(argv);
    const result = await runParsedCli(parsed, { output });
    output(renderAgentRecord(result));
    if (result.status === 'error') {
      process.exitCode = exitCodeForCliError(new DebruteCliError(result.code, result.message));
    }
  } catch (error) {
    const command = parsed?.command ?? errorCommand(error, argv);
    const cliFailure = cliErrorFromUnknown(error);
    process.exitCode = exitCodeForCliError(cliFailure);
    output(renderAgentRecord({
      status: 'error',
      command,
      code: cliFailure.code,
      message: cliFailure.message,
      fields: publicErrorFields(cliFailure.fields)
    }));
  }
}

async function runParsedCli(args: ParsedDebruteArgs, options: { output: (text: string) => void }): Promise<DebruteAgentResult> {
  if (args.command === 'commands' || args.command === 'help') {
    return runRuntimeCommand(args);
  }
  if (args.command === 'workbench.url') {
    return runWorkbenchCommand(args);
  }

  const { DebruteAppServer } = await import('@debrute/app-server');
  const skillsRuntime = await createCliSkillsRuntime();
  const server = new DebruteAppServer();
  try {
    if (args.scope === 'runtime') {
      return await runRuntimeCommand(args, {
        server,
        skillsService: skillsRuntime.skillsService
      });
    }
    if (args.scope === 'project') {
      return await runProjectCommand(args, server);
    }
    return await runGenerationCommand(args, server, { output: options.output });
  } finally {
    server.close();
  }
}

function cliErrorFromUnknown(error: unknown): DebruteCliError {
  if (isDebruteCliError(error)) {
    return error;
  }
  if (isErrorWithCode(error)) {
    return cliError(normalizeServiceErrorCode(error.code), error.message, primitiveErrorFields(error.fields));
  }
  return cliError('internal_error', messageFromUnknown(error));
}

function errorCommand(error: unknown, argv: string[]): string {
  if (isDebruteCliError(error) && typeof error.fields.command === 'string') {
    return error.fields.command;
  }
  return commandNameFromArgv(argv);
}

function isErrorWithCode(error: unknown): error is Error & { code: string; fields?: unknown } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}

function publicErrorFields(fields: DebruteCliError['fields']): DebruteCliError['fields'] {
  const { command: _command, ...rest } = fields;
  return rest;
}

if (isCliEntrypoint()) {
  configurePackagedNodeModules();
  const argv = process.argv.slice(2);
  if (argv[0] === INTERNAL_WORKBENCH_RUNTIME_CHILD_COMMAND) {
    void import('./workbench/internalWorkbenchRuntimeChild.js')
      .then(({ runInternalWorkbenchRuntimeChild }) => runInternalWorkbenchRuntimeChild())
      .catch((error) => {
        console.error(messageFromUnknown(error));
        process.exit(5);
      });
  } else {
    runCli(argv).catch((error) => {
      console.error(messageFromUnknown(error));
      process.exit(5);
    });
  }
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  if (typeof import.meta.url !== 'string') {
    return true;
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}
