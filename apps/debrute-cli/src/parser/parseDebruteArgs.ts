import { resolve } from 'node:path';
import { cliError } from '../errors/cliErrors.js';
import { commandSpecs, specForCommandPath, type DebruteCommandScope } from '../commands/helpSpec.js';

export type DebruteCliCommand =
  | 'update'
  | 'runtime.status'
  | 'runtime.doctor'
  | 'skills.status'
  | 'models.image.list'
  | 'models.image.describe'
  | 'models.video.list'
  | 'models.video.describe'
  | 'models.tts.list'
  | 'models.tts.describe'
  | 'models.music.list'
  | 'models.music.describe'
  | 'models.sfx.list'
  | 'models.sfx.describe'
  | 'project.init'
  | 'project.status'
  | 'project.validate'
  | 'workbench.start'
  | 'canvas-map.push'
  | 'canvas.create'
  | 'canvas.rename'
  | 'canvas.delete'
  | 'canvas.reorder'
  | 'canvas.repair-index'
  | 'canvas.reset-layout'
  | 'generated-asset.lookup'
  | 'generate.image'
  | 'generate.image-batch'
  | 'generate.video'
  | 'generate.tts'
  | 'generate.music'
  | 'generate.sfx'
  | 'commands'
  | 'help';

export interface ParsedDebruteArgs {
  command: DebruteCliCommand;
  scope: DebruteCommandScope;
  commandPath: string[];
  positional: string[];
  options: Record<string, string>;
  projectRoot?: string;
}

const POSITIONAL_COUNTS: Record<DebruteCliCommand, { min: number; max: number }> = {
  update: { min: 0, max: 0 },
  'runtime.status': { min: 0, max: 0 },
  'runtime.doctor': { min: 0, max: 0 },
  'skills.status': { min: 0, max: 0 },
  'models.image.list': { min: 0, max: 0 },
  'models.image.describe': { min: 1, max: 1 },
  'models.video.list': { min: 0, max: 0 },
  'models.video.describe': { min: 1, max: 1 },
  'models.tts.list': { min: 0, max: 0 },
  'models.tts.describe': { min: 1, max: 1 },
  'models.music.list': { min: 0, max: 0 },
  'models.music.describe': { min: 1, max: 1 },
  'models.sfx.list': { min: 0, max: 0 },
  'models.sfx.describe': { min: 1, max: 1 },
  'project.init': { min: 1, max: 1 },
  'project.status': { min: 1, max: 1 },
  'project.validate': { min: 1, max: 1 },
  'workbench.start': { min: 0, max: 0 },
  'canvas-map.push': { min: 2, max: 2 },
  'canvas.create': { min: 1, max: 1 },
  'canvas.rename': { min: 3, max: 3 },
  'canvas.delete': { min: 2, max: 2 },
  'canvas.reorder': { min: 2, max: Number.POSITIVE_INFINITY },
  'canvas.repair-index': { min: 1, max: 1 },
  'canvas.reset-layout': { min: 2, max: 2 },
  'generated-asset.lookup': { min: 1, max: 1 },
  'generate.image': { min: 1, max: 1 },
  'generate.image-batch': { min: 1, max: 1 },
  'generate.video': { min: 1, max: 1 },
  'generate.tts': { min: 1, max: 1 },
  'generate.music': { min: 1, max: 1 },
  'generate.sfx': { min: 1, max: 1 },
  commands: { min: 0, max: 0 },
  help: { min: 1, max: 3 }
};

const ALLOWED_OPTIONS: Record<DebruteCliCommand, Set<string>> = {
  update: new Set(),
  'runtime.status': new Set(),
  'runtime.doctor': new Set(),
  'skills.status': new Set(),
  'models.image.list': new Set(),
  'models.image.describe': new Set(),
  'models.video.list': new Set(),
  'models.video.describe': new Set(),
  'models.tts.list': new Set(),
  'models.tts.describe': new Set(),
  'models.music.list': new Set(),
  'models.music.describe': new Set(),
  'models.sfx.list': new Set(),
  'models.sfx.describe': new Set(),
  'project.init': new Set(),
  'project.status': new Set(),
  'project.validate': new Set(),
  'workbench.start': new Set(['next']),
  'canvas-map.push': new Set(),
  'canvas.create': new Set(),
  'canvas.rename': new Set(),
  'canvas.delete': new Set(),
  'canvas.reorder': new Set(),
  'canvas.repair-index': new Set(),
  'canvas.reset-layout': new Set(['all', 'path', 'glob']),
  'generated-asset.lookup': new Set(['path']),
  'generate.image': new Set(['input-json', 'timeout-ms']),
  'generate.image-batch': new Set(['manifest', 'input-jsonl', 'log', 'summary', 'concurrency', 'retries', 'timeout-ms', 'overwrite-existing']),
  'generate.video': new Set(['input-json', 'timeout-ms']),
  'generate.tts': new Set(['input-json', 'timeout-ms']),
  'generate.music': new Set(['input-json', 'timeout-ms']),
  'generate.sfx': new Set(['input-json', 'timeout-ms']),
  commands: new Set(),
  help: new Set()
};

const BOOLEAN_OPTIONS: Partial<Record<DebruteCliCommand, Set<string>>> = {
  'canvas.reset-layout': new Set(['all']),
  'generate.image-batch': new Set(['overwrite-existing'])
};

const REPEATABLE_OPTIONS: Partial<Record<DebruteCliCommand, Set<string>>> = {
  'canvas.reset-layout': new Set(['path', 'glob'])
};

const PROJECT_COMMANDS = new Set<DebruteCliCommand>([
  'project.init',
  'project.status',
  'project.validate',
  'canvas-map.push',
  'canvas.create',
  'canvas.rename',
  'canvas.delete',
  'canvas.reorder',
  'canvas.repair-index',
  'canvas.reset-layout',
  'generated-asset.lookup',
  'generate.image',
  'generate.image-batch',
  'generate.video',
  'generate.tts',
  'generate.music',
  'generate.sfx'
]);

export function parseDebruteArgs(argv: string[]): ParsedDebruteArgs {
  rejectJsonFlag(argv);
  const normalized = normalizeHelp(argv);
  const specItem = matchingSpec(normalized);
  if (!specItem) {
    const command = commandNameFromArgv(normalized);
    throw cliError('invalid_command', `Unknown Debrute CLI command: ${command}`, { command });
  }

  const rest = normalized.slice(specItem.path.length);
  const parsed = parsePositionalsAndOptions(specItem.command as DebruteCliCommand, rest);
  validatePositionals(specItem.command as DebruteCliCommand, parsed.positionals);
  validateRequiredOptions(specItem.command as DebruteCliCommand, parsed.options);

  const projectRoot = PROJECT_COMMANDS.has(specItem.command as DebruteCliCommand)
    ? resolve(parsed.positionals[0]!)
    : undefined;

  return {
    command: specItem.command as DebruteCliCommand,
    scope: specItem.scope,
    commandPath: specItem.path,
    positional: parsed.positionals,
    options: parsed.options,
    ...(projectRoot ? { projectRoot } : {})
  };
}

export function commandNameFromArgv(argv: string[]): string {
  const normalized = argv.filter((arg) => arg !== '--help' && arg !== '-h' && arg !== '--json');
  const specItem = matchingSpec(normalized);
  if (specItem) {
    return specItem.command;
  }
  if (normalized[0] && normalized[1] && !normalized[1].startsWith('--')) {
    return `${normalized[0]}.${normalized[1]}`;
  }
  return normalized[0] ?? 'commands';
}

function rejectJsonFlag(argv: string[]): void {
  if (argv.includes('--json')) {
    throw cliError('invalid_argument', '--json is not supported. Debrute CLI always emits debrute/1 Agent Records.');
  }
}

function normalizeHelp(argv: string[]): string[] {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return ['commands'];
  }
  const helpIndex = argv.findIndex((arg) => arg === '--help' || arg === '-h');
  if (helpIndex >= 0) {
    return ['help', ...argv.slice(0, helpIndex)];
  }
  return argv;
}

function matchingSpec(argv: string[]) {
  return commandSpecs
    .slice()
    .sort((left, right) => right.path.length - left.path.length)
    .find((specItem) => specItem.path.every((segment, index) => argv[index] === segment));
}

function parsePositionalsAndOptions(command: DebruteCliCommand, args: string[]): { positionals: string[]; options: Record<string, string> } {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  const repeatedOptions: Record<string, string[]> = {};
  const allowed = ALLOWED_OPTIONS[command];
  const repeatable = REPEATABLE_OPTIONS[command] ?? new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!allowed.has(key)) {
        throw cliError('invalid_argument', `Unknown option for ${command}: --${key}`, { command });
      }
      if (BOOLEAN_OPTIONS[command]?.has(key)) {
        options[key] = 'true';
        continue;
      }
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw cliError('missing_argument', `--${key} requires a value.`, { command });
      }
      if (repeatable.has(key)) {
        repeatedOptions[key] = [...(repeatedOptions[key] ?? []), value];
        options[key] = JSON.stringify(repeatedOptions[key]);
      } else {
        options[key] = value;
      }
      index += 1;
      continue;
    }
    positionals.push(arg);
  }

  return { positionals, options };
}

function validatePositionals(command: DebruteCliCommand, positionals: string[]): void {
  const count = POSITIONAL_COUNTS[command];
  if (positionals.length < count.min) {
    throw cliError('missing_argument', `${command} requires ${requiredPositionals(command)}.`, { command });
  }
  if (positionals.length > count.max) {
    throw cliError('invalid_argument', `Unexpected argument for ${command}: ${positionals[count.max]}`, { command });
  }
  if (command === 'help' && !specForCommandPath(positionals)) {
    throw cliError('invalid_command', `Unknown Debrute CLI command: ${positionals.join(' ')}`, {
      command: positionals.join('.')
    });
  }
}

function validateRequiredOptions(command: DebruteCliCommand, options: Record<string, string>): void {
  if ((command === 'generate.image'
    || command === 'generate.video'
    || command === 'generate.tts'
    || command === 'generate.music'
    || command === 'generate.sfx') && !options['input-json']) {
    throw cliError('missing_argument', '--input-json is required.', { command });
  }
  if (command === 'generated-asset.lookup' && !options.path) {
    throw cliError('missing_argument', '--path is required.', { command });
  }
  if (command === 'canvas.reset-layout') {
    const hasRule = Boolean(options.path || options.glob);
    if ((options.all === 'true') === hasRule) {
      throw cliError('invalid_input', 'canvas.reset-layout requires --all or at least one --path/--glob.', { command });
    }
  }
  if (command === 'generate.image-batch') {
    const sources = ['manifest', 'input-jsonl'].filter((key) => options[key]);
    if (sources.length !== 1) {
      throw cliError('invalid_input', 'generate.image-batch requires exactly one of --manifest or --input-jsonl.', { command });
    }
    if (!options.log) {
      throw cliError('missing_argument', '--log is required.', { command });
    }
  }
}

function requiredPositionals(command: DebruteCliCommand): string {
  if (command === 'help') {
    return '<command-path>';
  }
  if (command === 'models.image.describe'
    || command === 'models.video.describe'
    || command === 'models.tts.describe'
    || command === 'models.music.describe'
    || command === 'models.sfx.describe') {
    return '<model-id>';
  }
  if (command === 'canvas-map.push') {
    return '<project> <canvas-id>';
  }
  if (command === 'canvas.rename') {
    return '<project> <canvas-id> <name>';
  }
  if (command === 'canvas.delete') {
    return '<project> <canvas-id>';
  }
  if (command === 'canvas.reset-layout') {
    return '<project> <canvas-id> --all | [--path <literal...>] [--glob <pattern...>]';
  }
  if (command === 'canvas.reorder') {
    return '<project> <canvas-id...>';
  }
  return '<project>';
}
