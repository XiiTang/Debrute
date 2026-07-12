import { describe, expect, it } from 'vitest';
import { DebruteCliError, exitCodeForCliError } from '../errors/cliErrors.js';
import { parseDebruteArgs } from './parseDebruteArgs.js';

describe('Debrute argument parser', () => {
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
    expect(parseDebruteArgs(['update'])).toMatchObject({
      command: 'update',
      scope: 'runtime',
      positional: []
    });
    expect(parseDebruteArgs(['skills', 'status'])).toMatchObject({
      command: 'skills.status',
      scope: 'runtime',
      positional: []
    });
    expect(() => parseDebruteArgs(['skills', 'sync'])).toThrow(DebruteCliError);
    expect(parseDebruteArgs(['project', 'init', '/tmp/project'])).toMatchObject({
      command: 'project.init',
      scope: 'project',
      projectRoot: '/tmp/project'
    });
    const workbenchStart = parseDebruteArgs(['workbench', 'start']);
    expect(workbenchStart).toMatchObject({
      command: 'workbench.start',
      scope: 'runtime',
      positional: []
    });
    expect(workbenchStart.projectRoot).toBeUndefined();
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
      'prompts/cover [draft].md',
      '--glob',
      'outputs/**/*.png'
    ])).toMatchObject({
      command: 'canvas.reset-layout',
      positional: ['/tmp/project', 'canvas-1'],
      options: {
        path: '["outputs/gpt/","prompts/cover [draft].md"]',
        glob: '["outputs/**/*.png"]'
      }
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
        message: 'canvas.reset-layout requires --all or at least one --path/--glob.'
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
      'tts',
      '/tmp/project',
      '--input-json',
      '{"model":"openai-gpt-4o-mini-tts","arguments":{"text":"voice line"}}',
      '--timeout-ms',
      '600000'
    ])).toMatchObject({
      command: 'generate.tts',
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
});
