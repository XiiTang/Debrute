export type DebruteCommandScope = 'runtime' | 'project' | 'generation';
export type DebruteCommandRisk = 'read' | 'write' | 'generate' | 'destructive';
export type DebruteCommandRequirement = 'none' | 'project' | 'project-session' | 'model-config' | 'secrets';
export type DebruteCommandWrites = 'none' | 'debrute-project' | 'canvas-map' | 'canvas-registry' | 'assets' | 'metadata' | 'skills' | 'logs';

export interface DebruteCommandSpec {
  command: string;
  path: string[];
  scope: DebruteCommandScope;
  risk: DebruteCommandRisk;
  requires: DebruteCommandRequirement;
  writes: DebruteCommandWrites;
  input: string;
  output: string;
  errors: string[];
}

const PARSE_ERRORS = ['invalid_command', 'invalid_argument', 'missing_argument', 'invalid_input', 'internal_error'];
const PROJECT_LOAD_ERRORS = ['project_not_found', 'project_invalid'];
const CANVAS_REGISTRY_ERRORS = ['canvas_registry_missing', 'canvas_registry_invalid', 'canvas_registry_conflict', 'canvas_registry_repair_failed', 'canvas_map_conflict'];
const MODEL_RUNTIME_ERRORS = ['model_not_configured', 'model_unavailable', 'model_request_failed'];
const AUDIO_MODEL_RUNTIME_ERRORS = [
  'audio_model_not_configured',
  'audio_model_unavailable',
  'audio_model_kind_mismatch',
  'audio_argument_invalid',
  'audio_request_failed',
  'audio_artifact_download_failed',
  'audio_task_failed',
  'audio_task_timeout'
];
const AUDIO_MODEL_DESCRIBE_ERRORS = ['audio_model_unavailable', 'audio_model_kind_mismatch', 'runtime_config_error'];
const WORKBENCH_RUNTIME_ERRORS = [
  'runtime_launch_failed',
  'runtime_health_failed',
  'runtime_state_unreadable',
  'runtime_state_write_failed',
  'runtime_lock_timeout'
];

export const commandSpecs: DebruteCommandSpec[] = [
  spec('update', ['update'], 'runtime', 'write', 'none', 'logs', 'no args', 'product update record', [
    'runtime_launch_failed',
    'runtime_health_failed',
    'product_update_failed'
  ]),
  spec('runtime.status', ['runtime', 'status'], 'runtime', 'read', 'none', 'none', 'no args', 'runtime status record'),
  spec('runtime.doctor', ['runtime', 'doctor'], 'runtime', 'read', 'none', 'none', 'no args', 'diagnostic records', ['runtime_config_error']),
  spec('skills.status', ['skills', 'status'], 'runtime', 'read', 'none', 'none', 'no args', 'runtime-owned managed CLI and Skills diagnostic'),
  spec('models.image.list', ['models', 'image', 'list'], 'runtime', 'read', 'model-config', 'none', 'no args', 'image model records', ['runtime_config_error']),
  spec('models.image.describe', ['models', 'image', 'describe'], 'runtime', 'read', 'model-config', 'none', '<model-id>', 'image model detail record', ['model_unavailable', 'runtime_config_error']),
  spec('models.video.list', ['models', 'video', 'list'], 'runtime', 'read', 'model-config', 'none', 'no args', 'video model records', ['runtime_config_error']),
  spec('models.video.describe', ['models', 'video', 'describe'], 'runtime', 'read', 'model-config', 'none', '<model-id>', 'video model detail record', ['model_unavailable', 'runtime_config_error']),
  spec('models.tts.list', ['models', 'tts', 'list'], 'runtime', 'read', 'model-config', 'none', 'no args', 'TTS model records', ['runtime_config_error']),
  spec('models.tts.describe', ['models', 'tts', 'describe'], 'runtime', 'read', 'model-config', 'none', '<model-id>', 'TTS model detail record', AUDIO_MODEL_DESCRIBE_ERRORS),
  spec('models.music.list', ['models', 'music', 'list'], 'runtime', 'read', 'model-config', 'none', 'no args', 'music model records', ['runtime_config_error']),
  spec('models.music.describe', ['models', 'music', 'describe'], 'runtime', 'read', 'model-config', 'none', '<model-id>', 'music model detail record', AUDIO_MODEL_DESCRIBE_ERRORS),
  spec('models.sfx.list', ['models', 'sfx', 'list'], 'runtime', 'read', 'model-config', 'none', 'no args', 'sound effect model records', ['runtime_config_error']),
  spec('models.sfx.describe', ['models', 'sfx', 'describe'], 'runtime', 'read', 'model-config', 'none', '<model-id>', 'sound effect model detail record', AUDIO_MODEL_DESCRIBE_ERRORS),
  spec('project.init', ['project', 'init'], 'project', 'write', 'project', 'debrute-project', '<project>', 'project status record', ['project_invalid']),
  spec('project.status', ['project', 'status'], 'project', 'read', 'project', 'none', '<project>', 'project status record', PROJECT_LOAD_ERRORS),
  spec('project.validate', ['project', 'validate'], 'project', 'read', 'project', 'none', '<project>', 'validation problem records', [...PROJECT_LOAD_ERRORS, 'project_validation_failed']),
  spec('workbench.start', ['workbench', 'start'], 'runtime', 'write', 'none', 'logs', 'no args', 'Workbench runtime URL and port fields', WORKBENCH_RUNTIME_ERRORS),
  spec('canvas-map.push', ['canvas-map', 'push'], 'project', 'write', 'project', 'canvas-map', '<project> <canvas-id>', 'Canvas Map push record', [...PROJECT_LOAD_ERRORS, 'canvas_map_invalid_canvas_id', 'canvas_map_invalid_path', 'canvas_map_layout_conflict', 'canvas_map_read_failed', 'canvas_map_invalid_yaml', 'canvas_map_canvas_missing']),
  spec('canvas.create', ['canvas', 'create'], 'project', 'write', 'project', 'canvas-registry', '<project>', 'Canvas create record', [...PROJECT_LOAD_ERRORS, ...CANVAS_REGISTRY_ERRORS]),
  spec('canvas.rename', ['canvas', 'rename'], 'project', 'write', 'project', 'canvas-registry', '<project> <canvas-id> <name>', 'Canvas rename record', [...PROJECT_LOAD_ERRORS, ...CANVAS_REGISTRY_ERRORS]),
  spec('canvas.delete', ['canvas', 'delete'], 'project', 'destructive', 'project', 'canvas-registry', '<project> <canvas-id>', 'Canvas delete record', [...PROJECT_LOAD_ERRORS, ...CANVAS_REGISTRY_ERRORS]),
  spec('canvas.reorder', ['canvas', 'reorder'], 'project', 'write', 'project', 'canvas-registry', '<project> <canvas-id...>', 'Canvas reorder record', [...PROJECT_LOAD_ERRORS, ...CANVAS_REGISTRY_ERRORS]),
  spec('canvas.repair-index', ['canvas', 'repair-index'], 'project', 'write', 'project', 'canvas-registry', '<project>', 'Canvas registry repair record', [...PROJECT_LOAD_ERRORS, ...CANVAS_REGISTRY_ERRORS]),
  spec('canvas.reset-layout', ['canvas', 'reset-layout'], 'project', 'write', 'project', 'canvas-map', '<project> <canvas-id> --all | <project> <canvas-id> [--path <literal...>] [--glob <pattern...>]', 'Canvas layout reset record', [...PROJECT_LOAD_ERRORS, ...CANVAS_REGISTRY_ERRORS, 'canvas_map_invalid_path', 'canvas_map_invalid_yaml', 'canvas_map_canvas_missing']),
  spec('generated-asset.lookup', ['generated-asset', 'lookup'], 'project', 'read', 'project', 'none', '<project> --path <project-relative-path>', 'generated asset metadata record', PROJECT_LOAD_ERRORS),
  spec('generate.image', ['generate', 'image'], 'generation', 'generate', 'project-session', 'assets', '<project> --input-json <json> [--timeout-ms <ms>]', 'generated image artifact records', [...PROJECT_LOAD_ERRORS, 'invalid_json_input', ...MODEL_RUNTIME_ERRORS]),
  spec('generate.image-batch', ['generate', 'image-batch'], 'generation', 'generate', 'project-session', 'assets', '<project> --manifest <project-relative-path> --log <project-relative-path> [--summary <project-relative-path>] [--concurrency <n>] [--retries <n>] [--timeout-ms <ms>] [--overwrite-existing] | <project> --input-jsonl <project-relative-path> --log <project-relative-path> [--summary <project-relative-path>] [--concurrency <n>] [--retries <n>] [--timeout-ms <ms>] [--overwrite-existing]', 'batch progress and summary records', [...PROJECT_LOAD_ERRORS, ...MODEL_RUNTIME_ERRORS]),
  spec('generate.video', ['generate', 'video'], 'generation', 'generate', 'project-session', 'assets', '<project> --input-json <json> [--timeout-ms <ms>]', 'generated video artifact records', [...PROJECT_LOAD_ERRORS, 'invalid_json_input', ...MODEL_RUNTIME_ERRORS]),
  spec('generate.tts', ['generate', 'tts'], 'generation', 'generate', 'project-session', 'assets', '<project> --input-json <json> [--timeout-ms <ms>]', 'generated TTS audio artifact records', [...PROJECT_LOAD_ERRORS, 'invalid_json_input', ...AUDIO_MODEL_RUNTIME_ERRORS]),
  spec('generate.music', ['generate', 'music'], 'generation', 'generate', 'project-session', 'assets', '<project> --input-json <json> [--timeout-ms <ms>]', 'generated music audio artifact records', [...PROJECT_LOAD_ERRORS, 'invalid_json_input', ...AUDIO_MODEL_RUNTIME_ERRORS]),
  spec('generate.sfx', ['generate', 'sfx'], 'generation', 'generate', 'project-session', 'assets', '<project> --input-json <json> [--timeout-ms <ms>]', 'generated sound effect audio artifact records', [...PROJECT_LOAD_ERRORS, 'invalid_json_input', ...AUDIO_MODEL_RUNTIME_ERRORS]),
  spec('commands', ['commands'], 'runtime', 'read', 'none', 'none', 'no args', 'command spec records'),
  spec('help', ['help'], 'runtime', 'read', 'none', 'none', '<command-path>', 'one command spec record')
];

export function specForCommandPath(path: string[]): DebruteCommandSpec | undefined {
  return commandSpecs.find((specItem) => arraysEqual(specItem.path, path));
}

export function commandSpecRecords(specs: DebruteCommandSpec[] = commandSpecs) {
  return specs.map((specItem) => ({
    name: 'command',
    fields: {
      name: specItem.command,
      scope: specItem.scope,
      risk: specItem.risk,
      requires: specItem.requires,
      writes: specItem.writes,
      input: specItem.input,
      output: specItem.output,
      errors: specItem.errors.join(',')
    }
  }));
}

function spec(
  command: string,
  path: string[],
  scope: DebruteCommandScope,
  risk: DebruteCommandRisk,
  requires: DebruteCommandRequirement,
  writes: DebruteCommandWrites,
  input: string,
  output: string,
  errors: string[] = []
): DebruteCommandSpec {
  return {
    command,
    path,
    scope,
    risk,
    requires,
    writes,
    input,
    output,
    errors: [...new Set([...PARSE_ERRORS, ...errors])]
  };
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
