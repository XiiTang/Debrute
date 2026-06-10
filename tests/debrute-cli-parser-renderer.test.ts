import { describe, expect, it } from 'vitest';
import { DebruteCliError, exitCodeForCliError } from '../apps/debrute-cli/src/errors/cliErrors';
import { commandSpecs, specForCommandPath } from '../apps/debrute-cli/src/commands/helpSpec';
import { parseDebruteArgs } from '../apps/debrute-cli/src/parser/parseDebruteArgs';
import { renderAgentRecord } from '../apps/debrute-cli/src/output/renderAgentRecord';

describe('debrute cli parser and renderer', () => {
  it('rejects --json because the CLI has one output protocol', () => {
    expect(() => parseDebruteArgs(['project', 'status', '/tmp/project', '--json'])).toThrow(DebruteCliError);
    try {
      parseDebruteArgs(['project', 'status', '/tmp/project', '--json']);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_argument',
        message: '--json is not supported. Debrute CLI always emits debrute/1 Agent Records.'
      });
      expect(exitCodeForCliError(error)).toBe(2);
    }
  });

  it('parses final command scopes and paths', () => {
    expect(parseDebruteArgs(['runtime', 'status'])).toMatchObject({
      command: 'runtime.status',
      scope: 'runtime'
    });
    expect(parseDebruteArgs(['project', 'init', '/tmp/project'])).toMatchObject({
      command: 'project.init',
      scope: 'project',
      projectRoot: '/tmp/project'
    });
    expect(parseDebruteArgs(['generate', 'image-batch', '/tmp/project', '--input-jsonl', 'requests.jsonl', '--log', 'results.jsonl'])).toMatchObject({
      command: 'generate.image-batch',
      scope: 'generation',
      projectRoot: '/tmp/project',
      options: {
        'input-jsonl': 'requests.jsonl',
        log: 'results.jsonl'
      }
    });
    expect(parseDebruteArgs(['canvas-map', 'publish', '/tmp/project', 'production-map'])).toMatchObject({
      command: 'canvas-map.publish',
      scope: 'project',
      projectRoot: '/tmp/project',
      positional: ['/tmp/project', 'production-map']
    });
    expect(() => parseDebruteArgs(['daemon', 'status', '--daemon-url', 'http://127.0.0.1:17321'])).toThrow(DebruteCliError);
  });

  it('renders compact debrute/1 success and error records', () => {
    expect(renderAgentRecord({
      status: 'ok',
      command: 'models.image.list',
      fields: { count: 2 },
      records: [
        { name: 'model', fields: { id: 'gpt-image-2', parameters: '{"prompt":"required","size":"WIDTHxHEIGHT"}' } },
        { name: 'model', fields: { id: 'gemini preview', parameters: '{"prompt":"required","image_size":"1K|2K"}' } }
      ]
    })).toEqual([
      'debrute/1 ok cmd=models.image.list',
      'model id=gpt-image-2 parameters="{\\"prompt\\":\\"required\\",\\"size\\":\\"WIDTHxHEIGHT\\"}"',
      'model id="gemini preview" parameters="{\\"prompt\\":\\"required\\",\\"image_size\\":\\"1K|2K\\"}"',
      'count=2'
    ].join('\n'));

    expect(renderAgentRecord({
      status: 'error',
      command: 'project.status',
      code: 'project_not_found',
      message: 'Project metadata was not found.',
      fields: { path: '/tmp/missing project', hint: 'Run debrute project init first.' }
    })).toEqual([
      'debrute/1 error cmd=project.status code=project_not_found',
      'message="Project metadata was not found."',
      'path="/tmp/missing project"',
      'hint="Run debrute project init first."'
    ].join('\n'));
  });

  it('exposes command metadata for final help commands', () => {
    expect(commandSpecs.map((spec) => spec.command)).toEqual([
      'runtime.status',
      'runtime.doctor',
      'skills.status',
      'skills.sync',
      'models.image.list',
      'models.image.describe',
      'models.video.list',
      'models.video.describe',
      'llm.request',
      'project.init',
      'project.status',
      'project.validate',
      'workbench.url',
      'canvas-map.publish',
      'generated-asset.lookup',
      'generate.image',
      'generate.image-batch',
      'generate.video',
      'commands',
      'help'
    ]);
    expect(specForCommandPath(['generate', 'image-batch'])).toMatchObject({
      command: 'generate.image-batch',
      scope: 'generation',
      risk: 'generate',
      requires: 'project-session',
      writes: 'assets'
    });
    expect(specForCommandPath(['project', 'status'])?.errors).toContain('project_not_found');
    expect(specForCommandPath(['workbench', 'url'])).toMatchObject({
      command: 'workbench.url',
      scope: 'runtime',
      risk: 'write',
      requires: 'project',
      writes: 'debrute-project'
    });
    expect(specForCommandPath(['canvas-map', 'publish'])?.errors).toEqual(expect.arrayContaining([
      'canvas_map_invalid_canvas_id',
      'canvas_map_invalid_path',
      'canvas_map_read_failed',
      'canvas_map_invalid_yaml',
      'canvas_map_canvas_missing'
    ]));
    expect(specForCommandPath(['canvas-map', 'publish'])?.input).toBe('<project> <canvas-id>');
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
  });
});
