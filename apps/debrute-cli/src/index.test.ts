import { describe, expect, it } from 'vitest';
import { runCli } from './index.js';

describe('debrute-cli', () => {
  it('prints command specs instead of human help pages without touching runtime', async () => {
    const output: string[] = [];

    await runCli(['--help'], (text) => output.push(text));
    await runCli(['help', 'generate', 'image-batch'], (text) => output.push(text));

    expect(output[0]?.split('\n')[0]).toBe('debrute/1 ok cmd=commands');
    expect(output[0]).toContain('command name=generate.image-batch scope=generation risk=generate requires=project-session writes=assets');
    expect(output[0]).toContain('command name=models.tts.list scope=runtime risk=read requires=model-config writes=none');
    expect(output[0]).toContain('command name=generate.sfx scope=generation risk=generate requires=project-session writes=assets');
    expect(output[1]).toContain('debrute/1 ok cmd=help');
    expect(output[1]).toContain('command name=generate.image-batch scope=generation risk=generate requires=project-session writes=assets');
    expect(output[1]).toContain('[--timeout-ms <ms>]');
    expect(output[1]).toContain('[--overwrite-existing]');
  });

  it('rejects --json before runtime access', async () => {
    const originalExitCode = process.exitCode;
    try {
      const jsonOutput: string[] = [];
      await runCli(['project', 'status', '/tmp/project', '--json'], (text) => jsonOutput.push(text));
      expect(process.exitCode).toBe(2);
      expect(jsonOutput).toEqual([[
        'debrute/1 error cmd=project.status code=invalid_argument',
        'message="--json is not supported. Debrute CLI always emits debrute/1 Agent Records."'
      ].join('\n')]);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});
