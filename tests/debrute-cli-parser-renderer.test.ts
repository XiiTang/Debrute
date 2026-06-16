import { describe, expect, it } from 'vitest';
import { DebruteCliError, exitCodeForCliError } from '../apps/debrute-cli/src/errors/cliErrors';
import { commandSpecs, specForCommandPath } from '../apps/debrute-cli/src/commands/helpSpec';
import { parseDebruteArgs } from '../apps/debrute-cli/src/parser/parseDebruteArgs';
import { renderAgentProgressRecord, renderAgentRecord } from '../apps/debrute-cli/src/output/renderAgentRecord';

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
    expect(parseDebruteArgs(['canvas-map', 'push', '/tmp/project', 'canvas-1'])).toMatchObject({
      command: 'canvas-map.push',
      scope: 'project',
      projectRoot: '/tmp/project',
      positional: ['/tmp/project', 'canvas-1']
    });
    expect(parseDebruteArgs(['canvas', 'create', '/tmp/project'])).toMatchObject({
      command: 'canvas.create',
      scope: 'project',
      projectRoot: '/tmp/project',
      positional: ['/tmp/project']
    });
    expect(parseDebruteArgs(['canvas', 'rename', '/tmp/project', 'canvas-1', 'storyboard'])).toMatchObject({
      command: 'canvas.rename',
      positional: ['/tmp/project', 'canvas-1', 'storyboard']
    });
    expect(parseDebruteArgs(['canvas', 'delete', '/tmp/project', 'storyboard'])).toMatchObject({
      command: 'canvas.delete',
      positional: ['/tmp/project', 'storyboard']
    });
    expect(parseDebruteArgs(['canvas', 'reorder', '/tmp/project', 'storyboard', 'canvas-1'])).toMatchObject({
      command: 'canvas.reorder',
      positional: ['/tmp/project', 'storyboard', 'canvas-1']
    });
    expect(parseDebruteArgs(['canvas', 'repair-index', '/tmp/project'])).toMatchObject({
      command: 'canvas.repair-index',
      positional: ['/tmp/project']
    });
    expect(parseDebruteArgs(['canvas', 'reset-layout', '/tmp/project', 'canvas-1', '--all'])).toMatchObject({
      command: 'canvas.reset-layout',
      positional: ['/tmp/project', 'canvas-1'],
      options: { all: 'true' }
    });
    expect(parseDebruteArgs([
      'canvas',
      'reset-layout',
      '/tmp/project',
      'canvas-1',
      '--path',
      'outputs/gpt/',
      '--path',
      'prompts/cover.md'
    ])).toMatchObject({
      command: 'canvas.reset-layout',
      positional: ['/tmp/project', 'canvas-1'],
      options: { path: '["outputs/gpt/","prompts/cover.md"]' }
    });
    expect(() => parseDebruteArgs(['daemon', 'status', '--daemon-url', 'http://127.0.0.1:17321'])).toThrow(DebruteCliError);
  });

  it('validates canvas reset layout target options', () => {
    expect(() => parseDebruteArgs(['canvas', 'reset-layout', '/tmp/project', 'canvas-1'])).toThrow(DebruteCliError);
    try {
      parseDebruteArgs(['canvas', 'reset-layout', '/tmp/project', 'canvas-1']);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_input',
        message: 'canvas.reset-layout requires exactly one of --all or --path.'
      });
    }

    expect(() => parseDebruteArgs([
      'canvas',
      'reset-layout',
      '/tmp/project',
      'canvas-1',
      '--all',
      '--path',
      'outputs/gpt/'
    ])).toThrow(DebruteCliError);
  });

  it('parses final generation timeout flags', () => {
    expect(parseDebruteArgs([
      'generate',
      'image',
      '/tmp/project',
      '--input-json',
      '{"model":"gpt-image-2","arguments":{"prompt":"cover"}}',
      '--timeout-ms',
      '600000'
    ])).toMatchObject({
      command: 'generate.image',
      options: {
        'input-json': '{"model":"gpt-image-2","arguments":{"prompt":"cover"}}',
        'timeout-ms': '600000'
      }
    });

    expect(parseDebruteArgs([
      'generate',
      'video',
      '/tmp/project',
      '--input-json',
      '{"model":"doubao-seedance-2-0-260128","arguments":{"prompt":"move"}}',
      '--timeout-ms',
      '600000'
    ])).toMatchObject({
      command: 'generate.video',
      options: {
        'timeout-ms': '600000'
      }
    });

    expect(parseDebruteArgs([
      'generate',
      'image-batch',
      '/tmp/project',
      '--input-jsonl',
      'requests.jsonl',
      '--log',
      'results.jsonl',
      '--timeout-ms',
      '900000',
      '--overwrite-existing'
    ])).toMatchObject({
      command: 'generate.image-batch',
      options: {
        'input-jsonl': 'requests.jsonl',
        log: 'results.jsonl',
        'timeout-ms': '900000',
        'overwrite-existing': 'true'
      }
    });
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

  it('escapes terminal control characters in Agent Record values', () => {
    const rendered = renderAgentRecord({
      status: 'ok',
      command: 'llm.request',
      fields: {
        text: 'hello\u001b]52;c;AAAA\u0007world'
      }
    });

    expect(rendered).toBe('debrute/1 ok cmd=llm.request\ntext="hello\\u001b]52;c;AAAA\\u0007world"');
    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('\u0007');
  });

  it('renders progress records with the same field escaping rules', () => {
    expect(renderAgentProgressRecord('generate.image-batch', {
      total: 100,
      done: 10,
      ok: 8,
      failed: 1,
      skipped: 1,
      note: 'ten percent'
    })).toBe('debrute/1 progress cmd=generate.image-batch total=100 done=10 ok=8 failed=1 skipped=1 note="ten percent"');
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
    expect(imageBatchSpec?.input).toContain('--summary <path>');
    expect(imageBatchSpec?.input).toContain('--concurrency <n>');
    expect(imageBatchSpec?.input).toContain('--retries <n>');
    expect(specForCommandPath(['project', 'status'])?.errors).toContain('project_not_found');
    expect(specForCommandPath(['workbench', 'url'])).toMatchObject({
      command: 'workbench.url',
      scope: 'runtime',
      risk: 'write',
      requires: 'project',
      writes: 'debrute-project'
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
      input: '<project> <canvas-id> --all | <project> <canvas-id> --path <rule...>'
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
  });
});
