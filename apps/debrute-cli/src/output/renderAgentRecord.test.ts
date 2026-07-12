import { describe, expect, it } from 'vitest';
import { renderAgentProgressRecord, renderAgentRecord } from './renderAgentRecord.js';

describe('Debrute Agent Record renderer', () => {
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
      command: 'project.status',
      fields: {
        text: 'hello\u001b]52;c;AAAA\u0007world'
      }
    });

    expect(rendered).toBe('debrute/1 ok cmd=project.status\ntext="hello\\u001b]52;c;AAAA\\u0007world"');
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
});
