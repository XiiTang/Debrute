import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../apps/debrute-cli/src/index';

describe('debrute-cli', () => {
  it('initializes, reports, and validates projects with debrute/1 records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-project-'));
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-home-'));
    const originalHome = process.env.HOME;
    const originalExitCode = process.exitCode;
    try {
      process.env.HOME = home;
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
  }, 15_000);

  it('does not initialize missing projects for read-only project commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-readonly-noinit-'));
    const originalExitCode = process.exitCode;
    try {
      const output: string[] = [];

      await runCli(['project', 'status', root], (text) => output.push(text));

      expect(process.exitCode).toBe(1);
      expect(output).toEqual([expect.stringMatching(/^debrute\/1 error cmd=project\.status code=project_not_found\nmessage=/)]);
      await expect(readFile(join(root, '.debrute/project.json'), 'utf8')).rejects.toThrow();
    } finally {
      process.exitCode = originalExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes Flowmaps through flowmap publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-flowmap-publish-'));
    const originalExitCode = process.exitCode;
    try {
      await runCli(['project', 'init', root], () => {});
      await mkdir(join(root, '.debrute/flowmaps'), { recursive: true });
      await writeFile(join(root, '.debrute/flowmaps/image-production.draft.yaml'), [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include: []',
        ''
      ].join('\n'), 'utf8');

      const output: string[] = [];
      await runCli([
        'flowmap',
        'publish',
        root,
        '--from',
        '.debrute/flowmaps/image-production.draft.yaml'
      ], (text) => output.push(text));

      expect(output).toEqual(['debrute/1 ok cmd=flowmap.publish\nsource=.debrute/flowmaps/image-production.draft.yaml']);
      await expect(readFile(join(root, '.debrute/flowmaps/image-production.yaml'), 'utf8')).resolves.toContain('contentHash: sha256:');
    } finally {
      process.exitCode = originalExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns Flowmap-specific debrute/1 errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-flowmap-error-'));
    const originalExitCode = process.exitCode;
    try {
      await runCli(['project', 'init', root], () => {});

      const output: string[] = [];
      await runCli([
        'flowmap',
        'publish',
        root,
        '--from',
        '.debrute/flowmaps/new-map.draft.yaml'
      ], (text) => output.push(text));

      expect(process.exitCode).toBe(1);
      expect(output).toEqual([[
        'debrute/1 error cmd=flowmap.publish code=flowmap_draft_read_failed',
        'message="Flowmap draft could not be read."',
        'file_path=.debrute/flowmaps/new-map.draft.yaml'
      ].join('\n')]);
      await expect(readFile(join(root, '.debrute/flowmaps/new-map.yaml'), 'utf8')).rejects.toThrow();
    } finally {
      process.exitCode = originalExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses runtime-scoped model and llm commands without a project', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-runtime-home-'));
    const originalHome = process.env.HOME;
    const originalExitCode = process.exitCode;
    try {
      process.env.HOME = home;
      const output: string[] = [];

      await runCli(['runtime', 'status'], (text) => output.push(text));
      await runCli(['models', 'image', 'list'], (text) => output.push(text));
      await runCli(['models', 'video', 'list'], (text) => output.push(text));
      await runCli(['llm', 'request', '--input-json', '{"prompt":"Hello"}'], (text) => output.push(text));

      expect(output[0]?.split('\n')[0]).toBe('debrute/1 ok cmd=runtime.status');
      expect(output[1]).toContain('debrute/1 ok cmd=models.image.list');
      expect(output[1]).toContain('count=0');
      expect(output[2]).toContain('debrute/1 ok cmd=models.video.list');
      expect(output[2]).toContain('model id=');
      expect(output[3]).toContain('debrute/1 error cmd=llm.request code=model_not_configured');
      expect(output.join('\n')).not.toContain('projectRoot');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      process.exitCode = originalExitCode;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prints configured image model parameter summaries without config status fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-image-list-params-home-'));
    const originalHome = process.env.HOME;
    const originalExitCode = process.exitCode;
    try {
      process.env.HOME = home;
      await mkdir(join(home, '.debrute/config'), { recursive: true });
      await writeFile(join(home, '.debrute/config/secrets.json'), JSON.stringify({
        llmProviderApiKeys: {},
        imageModelApiKeys: { 'gpt-image-2': 'sk-image' },
        videoModelApiKeys: {}
      }, null, 2), 'utf8');
      const output: string[] = [];

      await runCli(['models', 'image', 'list'], (text) => output.push(text));

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('debrute/1 ok cmd=models.image.list');
      expect(output[0]).toContain('model id=gpt-image-2 parameters=');
      expect(output[0]).toContain('\\"size\\":\\"WIDTHxHEIGHT');
      expect(output[0]).toContain('\\"image\\":');
      expect(output[0]).toContain('\\"mask\\":');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      process.exitCode = originalExitCode;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('returns stable user-facing errors for unknown model descriptions', async () => {
    const output: string[] = [];
    const originalExitCode = process.exitCode;
    try {
      await runCli(['models', 'image', 'describe', '__missing_model__'], (text) => output.push(text));

      expect(process.exitCode).toBe(4);
      expect(output).toEqual([[
        'debrute/1 error cmd=models.image.describe code=model_unavailable',
        'message="Image model is unknown: __missing_model__"',
        'model=__missing_model__'
      ].join('\n')]);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('prints official image model documentation in model describe output', async () => {
    const output: string[] = [];
    const originalExitCode = process.exitCode;
    try {
      await runCli(['models', 'image', 'describe', 'gpt-image-2'], (text) => output.push(text));

      expect(process.exitCode).toBeUndefined();
      expect(output[0]).toContain('debrute/1 ok cmd=models.image.describe');
      expect(output[0]).toContain('model id=gpt-image-2');
      expect(output[0]).toContain('official_doc urls=');
      expect(output[0]).toContain('snapshot=packages/capability-runtime/src/imageModels/officialDocs/snapshots/openai/image-generation.md');
      expect(output[0]).toContain('captured_at=');
      expect(output[0]).toContain('arguments_schema=');
      expect(output[0]).toContain('description_markdown=');
      expect(output[0]).toContain('Official documentation:');
      expect(output[0]).toContain('debrute generate image <project> --input-json');
      expect(output[0]).toContain('\\"model\\":\\"gpt-image-2\\"');
      expect(output[0]).not.toMatch(/curl\s+https:\/\/api\./i);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('returns configuration exit codes for known generation models without config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-generate-config-'));
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-generate-config-home-'));
    const originalHome = process.env.HOME;
    const originalExitCode = process.exitCode;
    try {
      process.env.HOME = home;
      await runCli(['project', 'init', root], () => {});
      const output: string[] = [];

      await runCli([
        'generate',
        'image',
        root,
        '--input-json',
        '{"model":"gpt-image-2","arguments":{"prompt":"cover"}}'
      ], (text) => output.push(text));

      expect(process.exitCode).toBe(3);
      expect(output).toEqual([[
        'debrute/1 error cmd=generate.image code=model_not_configured',
        'message="Image model API key is missing: gpt-image-2"',
        'content="Image model API key is missing: gpt-image-2"',
        'model=gpt-image-2'
      ].join('\n')]);
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
  });

  it('returns configuration exit codes when generation model API keys are missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-generate-auth-'));
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-generate-auth-home-'));
    const originalHome = process.env.HOME;
    const originalExitCode = process.exitCode;
    try {
      process.env.HOME = home;
      await runCli(['project', 'init', root], () => {});
      await mkdir(join(home, '.debrute/config'), { recursive: true });
      await writeFile(join(home, '.debrute/config/image_models.json'), JSON.stringify({
        imageModels: [{
          debruteModelId: 'gpt-image-2',
          baseUrlOverride: 'https://api.openai.com/v1',
          requestModelIdOverride: 'gpt-image-2'
        }]
      }, null, 2), 'utf8');
      const output: string[] = [];

      await runCli([
        'generate',
        'image',
        root,
        '--input-json',
        '{"model":"gpt-image-2","arguments":{"prompt":"cover"}}'
      ], (text) => output.push(text));

      expect(process.exitCode).toBe(3);
      expect(output).toEqual([[
        'debrute/1 error cmd=generate.image code=model_not_configured',
        'message="Image model API key is missing: gpt-image-2"',
        'content="Image model API key is missing: gpt-image-2"',
        'model=gpt-image-2'
      ].join('\n')]);
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
  });

  it('looks up generated asset metadata through a project command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-generated-asset-'));
    const originalExitCode = process.exitCode;
    try {
      await runCli(['project', 'init', root], () => {});

      const output: string[] = [];
      await runCli(['generated-asset', 'lookup', root, '--path', 'missing.png'], (text) => output.push(text));

      expect(output).toEqual([expect.stringContaining('debrute/1 ok cmd=generated-asset.lookup\nstatus=unavailable\nreason=missing')]);
    } finally {
      process.exitCode = originalExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prints command specs instead of human help pages', async () => {
    const output: string[] = [];

    await runCli(['--help'], (text) => output.push(text));
    await runCli(['help', 'generate', 'image-batch'], (text) => output.push(text));

    expect(output[0]?.split('\n')[0]).toBe('debrute/1 ok cmd=commands');
    expect(output[0]).toContain('command name=generate.image-batch scope=generation risk=generate requires=project-session writes=assets');
    expect(output[1]).toContain('debrute/1 ok cmd=help');
    expect(output[1]).toContain('command name=generate.image-batch scope=generation risk=generate requires=project-session writes=assets');
  });

  it('rejects --json', async () => {
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
