import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../apps/debrute-cli/src/index';

describe('debrute-cli', () => {
  it('initializes, reports, and validates projects through the runtime-backed CLI path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-project-'));
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-home-'));
    const originalHome = process.env.HOME;
    const originalExitCode = process.exitCode;
    try {
      process.env.HOME = home;
      process.exitCode = undefined;
      const output: string[] = [];

      await runCli(['project', 'init', root], (text) => output.push(text));
      await runCli(['project', 'status', root], (text) => output.push(text));
      await runCli(['project', 'validate', root], (text) => output.push(text));

      expect(output[0]?.split('\n')[0]).toBe('debrute/1 ok cmd=project.init');
      expect(output[1]).toContain('debrute/1 ok cmd=project.status');
      expect(output[1]).toContain('project_name=');
      expect(output[2]).toContain('debrute/1 ok cmd=project.validate');
      expect(output[2]).toContain('errors=0');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      process.exitCode = originalExitCode;
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

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

  it('does not construct app-server inside the CLI process for runtime-backed commands', () => {
    const cliEntry = readFileSync(join(process.cwd(), 'apps/debrute-cli/src/index.ts'), 'utf8');
    const runtimeCommands = readFileSync(join(process.cwd(), 'apps/debrute-cli/src/commands/runtimeCommands.ts'), 'utf8');

    expect(cliEntry).toContain('runRuntimeBackedCliCommand');
    expect(cliEntry).toContain('runtimePolicyForCommand');
    expect(cliEntry).not.toContain("@debrute/app-server");
    expect(cliEntry).not.toContain('new DebruteAppServer');
    expect(cliEntry).not.toContain('runProjectCommand');
    expect(cliEntry).not.toContain('runGenerationCommand');
    expect(runtimeCommands).not.toContain('@debrute/app-server');
    expect(runtimeCommands).not.toContain('requiredServer');
    expect(existsSync(join(process.cwd(), 'apps/debrute-cli/src/commands/projectCommands.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'apps/debrute-cli/src/commands/generationCommands.ts'))).toBe(false);
  });
});
