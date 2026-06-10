export type DebruteCommandScope = 'runtime' | 'project' | 'generation';
export type DebruteCommandRisk = 'read' | 'write' | 'generate' | 'destructive';
export type DebruteCommandRequirement = 'none' | 'project' | 'project-session' | 'model-config' | 'secrets';
export type DebruteCommandWrites = 'none' | 'debrute-project' | 'canvas-map' | 'assets' | 'metadata' | 'skills' | 'logs';

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
const MODEL_RUNTIME_ERRORS = ['model_not_configured', 'model_unavailable', 'model_request_failed'];
const WORKBENCH_RUNTIME_ERRORS = [
  'runtime_launch_failed',
  'runtime_health_failed',
  'runtime_state_unreadable',
  'runtime_state_write_failed',
  'runtime_lock_timeout'
];

export const commandSpecs: DebruteCommandSpec[] = [
  spec('runtime.status', ['runtime', 'status'], 'runtime', 'read', 'none', 'none', 'no args', 'runtime status record'),
  spec('runtime.doctor', ['runtime', 'doctor'], 'runtime', 'read', 'none', 'none', 'no args', 'diagnostic records', ['runtime_config_error']),
  spec('skills.status', ['skills', 'status'], 'runtime', 'read', 'none', 'none', 'no args', 'installed, missing, and skipped Debrute Skill records'),
  spec('skills.sync', ['skills', 'sync'], 'runtime', 'write', 'none', 'skills', '[--force]', 'updated, added, and skipped Debrute Skill records', [
    'skills_bundle_unavailable',
    'skills_bundle_invalid',
    'skills_permission_denied',
    'skills_sync_failed'
  ]),
  spec('models.image.list', ['models', 'image', 'list'], 'runtime', 'read', 'model-config', 'none', 'no args', 'image model records', ['runtime_config_error']),
  spec('models.image.describe', ['models', 'image', 'describe'], 'runtime', 'read', 'model-config', 'none', '<model-id>', 'image model detail record', ['model_unavailable', 'runtime_config_error']),
  spec('models.video.list', ['models', 'video', 'list'], 'runtime', 'read', 'model-config', 'none', 'no args', 'video model records', ['runtime_config_error']),
  spec('models.video.describe', ['models', 'video', 'describe'], 'runtime', 'read', 'model-config', 'none', '<model-id>', 'video model detail record', ['model_unavailable', 'runtime_config_error']),
  spec('llm.request', ['llm', 'request'], 'runtime', 'generate', 'secrets', 'none', '--input-json <json>', 'llm response records', ['invalid_json_input', 'model_not_configured', 'model_unavailable', 'model_request_failed', 'runtime_config_error']),
  spec('project.init', ['project', 'init'], 'project', 'write', 'project', 'debrute-project', '<project>', 'project status record', ['project_invalid']),
  spec('project.status', ['project', 'status'], 'project', 'read', 'project', 'none', '<project>', 'project status record', PROJECT_LOAD_ERRORS),
  spec('project.validate', ['project', 'validate'], 'project', 'read', 'project', 'none', '<project>', 'validation problem records', [...PROJECT_LOAD_ERRORS, 'project_validation_failed']),
  spec('workbench.url', ['workbench', 'url'], 'runtime', 'write', 'project', 'debrute-project', '<project>', 'Workbench URL and runtime port fields', [...PROJECT_LOAD_ERRORS, ...WORKBENCH_RUNTIME_ERRORS]),
  spec('canvas-map.publish', ['canvas-map', 'publish'], 'project', 'write', 'project', 'canvas-map', '<project> <canvas-id>', 'Canvas Map publish record', [...PROJECT_LOAD_ERRORS, 'canvas_map_invalid_canvas_id', 'canvas_map_invalid_path', 'canvas_map_layout_conflict', 'canvas_map_read_failed', 'canvas_map_invalid_yaml', 'canvas_map_canvas_missing']),
  spec('generated-asset.lookup', ['generated-asset', 'lookup'], 'project', 'read', 'project', 'none', '<project> --path <project-relative-path>', 'generated asset metadata record', PROJECT_LOAD_ERRORS),
  spec('generate.image', ['generate', 'image'], 'generation', 'generate', 'project-session', 'assets', '<project> --input-json <json>', 'generated image artifact records', [...PROJECT_LOAD_ERRORS, 'invalid_json_input', ...MODEL_RUNTIME_ERRORS]),
  spec('generate.image-batch', ['generate', 'image-batch'], 'generation', 'generate', 'project-session', 'assets', '<project> --manifest <path> --log <path> | <project> --input-jsonl <path> --log <path>', 'batch summary records', [...PROJECT_LOAD_ERRORS, ...MODEL_RUNTIME_ERRORS]),
  spec('generate.video', ['generate', 'video'], 'generation', 'generate', 'project-session', 'assets', '<project> --input-json <json>', 'generated video artifact records', [...PROJECT_LOAD_ERRORS, 'invalid_json_input', ...MODEL_RUNTIME_ERRORS]),
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
