import { describe, expect, it } from 'vitest';
import { commandSpecs, specForCommandPath } from './helpSpec.js';

describe('Debrute CLI help specification', () => {
  it('exposes command metadata for final help commands', () => {
    expect(commandSpecs.map((spec) => spec.command)).toEqual([
      'update',
      'runtime.status',
      'runtime.doctor',
      'skills.status',
      'models.image.list',
      'models.image.describe',
      'models.video.list',
      'models.video.describe',
      'models.tts.list',
      'models.tts.describe',
      'models.music.list',
      'models.music.describe',
      'models.sfx.list',
      'models.sfx.describe',
      'project.init',
      'project.status',
      'project.validate',
      'workbench.start',
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
      'generate.sfx',
      'commands',
      'help'
    ]);
    const imageBatchSpec = specForCommandPath(['generate', 'image-batch']);
    expect(imageBatchSpec).toMatchObject({
      command: 'generate.image-batch',
      scope: 'generation',
      risk: 'generate',
      requires: 'project-session',
      writes: 'assets'
    });
    expect(imageBatchSpec?.input).toContain('--summary <project-relative-path>');
    expect(imageBatchSpec?.input).toContain('--concurrency <n>');
    expect(imageBatchSpec?.input).toContain('--retries <n>');
    expect(specForCommandPath(['models', 'tts', 'describe'])).toMatchObject({
      command: 'models.tts.describe',
      requires: 'model-config'
    });
    expect(specForCommandPath(['generate', 'music'])).toMatchObject({
      command: 'generate.music',
      scope: 'generation',
      writes: 'assets'
    });
    expect(specForCommandPath(['project', 'status'])?.errors).toContain('project_not_found');
    expect(specForCommandPath(['workbench', 'start'])).toMatchObject({
      command: 'workbench.start',
      scope: 'runtime',
      risk: 'write',
      requires: 'none',
      writes: 'logs'
    });
    expect(specForCommandPath(['canvas-map', 'push'])?.errors).toEqual(expect.arrayContaining([
      'canvas_map_invalid_canvas_id',
      'canvas_map_invalid_path',
      'canvas_map_read_failed',
      'canvas_map_invalid_yaml',
      'canvas_map_canvas_missing'
    ]));
    expect(specForCommandPath(['canvas-map', 'push'])?.input).toBe('<project> <canvas-id>');
    expect(specForCommandPath(['canvas', 'rename'])?.errors).toEqual(expect.arrayContaining([
      'canvas_registry_conflict',
      'canvas_map_conflict'
    ]));
    expect(specForCommandPath(['canvas', 'reset-layout'])).toMatchObject({
      command: 'canvas.reset-layout',
      scope: 'project',
      risk: 'write',
      requires: 'project',
      writes: 'canvas-map',
      input: '<project> <canvas-id> --all | <project> <canvas-id> [--path <literal...>] [--glob <pattern...>]'
    });
    expect(specForCommandPath(['generate', 'image'])?.errors).toEqual([
      'invalid_command',
      'invalid_argument',
      'missing_argument',
      'invalid_input',
      'internal_error',
      'project_not_found',
      'project_invalid',
      'invalid_json_input',
      'model_not_configured',
      'model_unavailable',
      'model_request_failed'
    ]);
    expect(specForCommandPath(['generate', 'tts'])?.errors).toEqual(expect.arrayContaining([
      'audio_task_failed',
      'audio_task_timeout'
    ]));
    expect(specForCommandPath(['generate', 'music'])?.errors).toEqual(expect.arrayContaining([
      'audio_task_failed',
      'audio_task_timeout'
    ]));
    expect(specForCommandPath(['generate', 'sfx'])?.errors).toEqual(expect.arrayContaining([
      'audio_task_failed',
      'audio_task_timeout'
    ]));
    for (const path of [['models', 'tts', 'describe'], ['models', 'music', 'describe'], ['models', 'sfx', 'describe']]) {
      expect(specForCommandPath(path)?.errors).toEqual(expect.arrayContaining([
        'audio_model_kind_mismatch'
      ]));
    }
  });
});
