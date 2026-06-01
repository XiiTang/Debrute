import { resolve } from 'node:path';
import { cliError } from '../errors/cliErrors.js';
import { commandSpecs, specForCommandPath, type AxisCommandScope } from '../commands/helpSpec.js';

export type AxisCliCommand =
  | 'runtime.status'
  | 'runtime.doctor'
  | 'skills.status'
  | 'skills.sync'
  | 'models.image.list'
  | 'models.image.describe'
  | 'models.video.list'
  | 'models.video.describe'
  | 'llm.request'
  | 'project.init'
  | 'project.status'
  | 'project.validate'
  | 'flowmap.publish'
  | 'generated-asset.lookup'
  | 'generate.image'
  | 'generate.image-batch'
  | 'generate.video'
  | 'commands'
  | 'help';

export interface ParsedAxisArgs {
  command: AxisCliCommand;
  scope: AxisCommandScope;
  commandPath: string[];
  positional: string[];
  options: Record<string, string>;
  projectRoot?: string;
}

const POSITIONAL_COUNTS: Record<AxisCliCommand, { min: number; max: number }> = {
  'runtime.status': { min: 0, max: 0 },
  'runtime.doctor': { min: 0, max: 0 },
  'skills.status': { min: 0, max: 0 },
  'skills.sync': { min: 0, max: 0 },
  'models.image.list': { min: 0, max: 0 },
  'models.image.describe': { min: 1, max: 1 },
  'models.video.list': { min: 0, max: 0 },
  'models.video.describe': { min: 1, max: 1 },
  'llm.request': { min: 0, max: 0 },
  'project.init': { min: 1, max: 1 },
  'project.status': { min: 1, max: 1 },
  'project.validate': { min: 1, max: 1 },
  'flowmap.publish': { min: 1, max: 1 },
  'generated-asset.lookup': { min: 1, max: 1 },
  'generate.image': { min: 1, max: 1 },
  'generate.image-batch': { min: 1, max: 1 },
  'generate.video': { min: 1, max: 1 },
  commands: { min: 0, max: 0 },
  help: { min: 1, max: 3 }
};

const ALLOWED_OPTIONS: Record<AxisCliCommand, Set<string>> = {
  'runtime.status': new Set(),
  'runtime.doctor': new Set(),
  'skills.status': new Set(),
  'skills.sync': new Set(['force']),
  'models.image.list': new Set(),
  'models.image.describe': new Set(),
  'models.video.list': new Set(),
  'models.video.describe': new Set(),
  'llm.request': new Set(['input-json']),
  'project.init': new Set(),
  'project.status': new Set(),
  'project.validate': new Set(),
  'flowmap.publish': new Set(['from']),
  'generated-asset.lookup': new Set(['path']),
  'generate.image': new Set(['input-json']),
  'generate.image-batch': new Set(['manifest', 'input-jsonl', 'log', 'summary', 'concurrency', 'retries', 'timeout-ms']),
  'generate.video': new Set(['input-json']),
  commands: new Set(),
  help: new Set()
};

const BOOLEAN_OPTIONS: Partial<Record<AxisCliCommand, Set<string>>> = {
  'skills.sync': new Set(['force'])
};

const PROJECT_COMMANDS = new Set<AxisCliCommand>([
  'project.init',
  'project.status',
  'project.validate',
  'flowmap.publish',
  'generated-asset.lookup',
  'generate.image',
  'generate.image-batch',
  'generate.video'
]);

export function parseAxisArgs(argv: string[]): ParsedAxisArgs {
  rejectJsonFlag(argv);
  const normalized = normalizeHelp(argv);
  const specItem = matchingSpec(normalized);
  if (!specItem) {
    const command = commandNameFromArgv(normalized);
    throw cliError('invalid_command', `Unknown AXIS CLI command: ${command}`, { command });
  }

  const rest = normalized.slice(specItem.path.length);
  const parsed = parsePositionalsAndOptions(specItem.command as AxisCliCommand, rest);
  validatePositionals(specItem.command as AxisCliCommand, parsed.positionals);
  validateRequiredOptions(specItem.command as AxisCliCommand, parsed.options);

  const projectRoot = PROJECT_COMMANDS.has(specItem.command as AxisCliCommand)
    ? resolve(parsed.positionals[0]!)
    : undefined;

  return {
    command: specItem.command as AxisCliCommand,
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
    throw cliError('invalid_argument', '--json is not supported. AXIS CLI always emits axis/1 Agent Records.');
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

function parsePositionalsAndOptions(command: AxisCliCommand, args: string[]): { positionals: string[]; options: Record<string, string> } {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  const allowed = ALLOWED_OPTIONS[command];

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
      options[key] = value;
      index += 1;
      continue;
    }
    positionals.push(arg);
  }

  return { positionals, options };
}

function validatePositionals(command: AxisCliCommand, positionals: string[]): void {
  const count = POSITIONAL_COUNTS[command];
  if (positionals.length < count.min) {
    throw cliError('missing_argument', `${command} requires ${requiredPositionals(command)}.`, { command });
  }
  if (positionals.length > count.max) {
    throw cliError('invalid_argument', `Unexpected argument for ${command}: ${positionals[count.max]}`, { command });
  }
  if (command === 'help' && !specForCommandPath(positionals)) {
    throw cliError('invalid_command', `Unknown AXIS CLI command: ${positionals.join(' ')}`, {
      command: positionals.join('.')
    });
  }
}

function validateRequiredOptions(command: AxisCliCommand, options: Record<string, string>): void {
  if ((command === 'llm.request' || command === 'generate.image' || command === 'generate.video') && !options['input-json']) {
    throw cliError('missing_argument', '--input-json is required.', { command });
  }
  if (command === 'flowmap.publish' && !options.from) {
    throw cliError('missing_argument', '--from is required.', { command });
  }
  if (command === 'generated-asset.lookup' && !options.path) {
    throw cliError('missing_argument', '--path is required.', { command });
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

function requiredPositionals(command: AxisCliCommand): string {
  if (command === 'help') {
    return '<command-path>';
  }
  if (command === 'models.image.describe' || command === 'models.video.describe') {
    return '<model-id>';
  }
  return '<project>';
}
