import { describe, expect, it } from 'vitest';
import { AxisCliError, exitCodeForCliError, normalizeServiceErrorCode } from '../apps/axis-cli/src/errors/cliErrors';
import { commandSpecs, specForCommandPath } from '../apps/axis-cli/src/commands/helpSpec';
import { parseAxisArgs } from '../apps/axis-cli/src/parser/parseAxisArgs';
import { renderAgentRecord } from '../apps/axis-cli/src/output/renderAgentRecord';

describe('axis cli parser and renderer', () => {
  it('rejects --json because the CLI has one output protocol', () => {
    expect(() => parseAxisArgs(['project', 'status', '/tmp/project', '--json'])).toThrow(AxisCliError);
    try {
      parseAxisArgs(['project', 'status', '/tmp/project', '--json']);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_argument',
        message: '--json is not supported. AXIS CLI always emits axis/1 Agent Records.'
      });
      expect(exitCodeForCliError(error)).toBe(2);
    }
  });

  it('parses final command scopes and paths', () => {
    expect(parseAxisArgs(['runtime', 'status'])).toMatchObject({
      command: 'runtime.status',
      scope: 'runtime'
    });
    expect(parseAxisArgs(['project', 'init', '/tmp/project'])).toMatchObject({
      command: 'project.init',
      scope: 'project',
      projectRoot: '/tmp/project'
    });
    expect(parseAxisArgs(['generate', 'image-batch', '/tmp/project', '--input-jsonl', 'requests.jsonl', '--log', 'results.jsonl'])).toMatchObject({
      command: 'generate.image-batch',
      scope: 'generation',
      projectRoot: '/tmp/project',
      options: {
        'input-jsonl': 'requests.jsonl',
        log: 'results.jsonl'
      }
    });
  });

  it('renders compact axis/1 success and error records', () => {
    expect(renderAgentRecord({
      status: 'ok',
      command: 'models.image.list',
      fields: { count: 2 },
      records: [
        { name: 'model', fields: { id: 'gpt-image-2', provider: 'openai', parameters: '{"prompt":"required","size":"WIDTHxHEIGHT"}' } },
        { name: 'model', fields: { id: 'gemini preview', provider: 'google-gemini', parameters: '{"prompt":"required","image_size":"1K|2K"}' } }
      ]
    })).toEqual([
      'axis/1 ok cmd=models.image.list',
      'model id=gpt-image-2 provider=openai parameters="{\\"prompt\\":\\"required\\",\\"size\\":\\"WIDTHxHEIGHT\\"}"',
      'model id="gemini preview" provider=google-gemini parameters="{\\"prompt\\":\\"required\\",\\"image_size\\":\\"1K|2K\\"}"',
      'count=2'
    ].join('\n'));

    expect(renderAgentRecord({
      status: 'error',
      command: 'project.status',
      code: 'project_not_found',
      message: 'Project metadata was not found.',
      fields: { path: '/tmp/missing project', hint: 'Run axis project init first.' }
    })).toEqual([
      'axis/1 error cmd=project.status code=project_not_found',
      'message="Project metadata was not found."',
      'path="/tmp/missing project"',
      'hint="Run axis project init first."'
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
      'flowmap.publish',
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
    expect(specForCommandPath(['flowmap', 'publish'])?.errors).toEqual(expect.arrayContaining([
      'flowmap_invalid_draft_path',
      'flowmap_draft_read_failed',
      'flowmap_invalid_yaml'
    ]));
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
      'provider_request_failed',
      'generated_asset_write_failed'
    ]);
  });

  it('does not preserve mappings for removed service error codes', () => {
    expect(normalizeServiceErrorCode('no_available_image_model')).toBe('internal_error');
    expect(normalizeServiceErrorCode('generated_asset_record_failed')).toBe('internal_error');
  });
});
