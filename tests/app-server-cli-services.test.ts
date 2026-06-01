import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AxisAppServer, GlobalConfigStore } from '../apps/app-server/src/index';
import { createImageModelCatalog } from '@axis/capability-runtime';

describe('AxisAppServer CLI service methods', () => {
  it('exposes runtime model summaries without opening a project', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-cli-model-summaries-home-'));
    const server = new AxisAppServer({
      globalConfigStore: new GlobalConfigStore({ axisHome: home })
    });
    try {
      const imageModels = await server.listImageModelsForCli();
      const videoModels = await server.listVideoModelsForCli();

      expect(imageModels).toEqual([]);
      expect(videoModels.length).toBeGreaterThan(0);
      expect(() => server.getSnapshot()).toThrow('No project session is open.');
      expect(videoModels[0]).toMatchObject({
        id: expect.any(String),
        provider: expect.any(String)
      });
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('lists only API-key configured image models with original parameter summaries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-cli-image-list-parameters-home-'));
    const server = new AxisAppServer({
      globalConfigStore: new GlobalConfigStore({ axisHome: home })
    });
    try {
      await server.imageModelSaveSetting('gpt-image-2', { baseUrlOverride: null, providerModelIdOverride: null, apiKey: 'sk-image' });
      const imageModels = await server.listImageModelsForCli();

      expect(imageModels).toEqual([expect.objectContaining({
        id: 'gpt-image-2',
        provider: 'openai',
        parameters: expect.objectContaining({
          prompt: expect.stringContaining('required'),
          size: expect.stringContaining('WIDTHxHEIGHT'),
          image: expect.stringContaining('reference'),
          mask: expect.stringContaining('alpha channel')
        })
      })]);
      expect(JSON.stringify(imageModels)).not.toContain('enabled');
      expect(JSON.stringify(imageModels)).not.toContain('available');
      expect(JSON.stringify(imageModels)).not.toContain('apiKeySet');
      expect(JSON.stringify(imageModels)).not.toContain(`input_${'images'}`);
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports catalog image model count separately from API-key configured image models', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-cli-runtime-status-image-count-home-'));
    const server = new AxisAppServer({
      globalConfigStore: new GlobalConfigStore({ axisHome: home })
    });
    try {
      const catalogCount = createImageModelCatalog().listAll().length;
      await expect(server.runtimeStatusForCli()).resolves.toMatchObject({
        imageModels: catalogCount,
        availableImageModels: 0,
        diagnostics: 0
      });
      await expect(server.runtimeStatusForCli()).resolves.not.toHaveProperty('skills');

      await server.imageModelSaveSetting('gpt-image-2', {
        baseUrlOverride: null,
        providerModelIdOverride: null,
        apiKey: 'sk-image'
      });

      await expect(server.runtimeStatusForCli()).resolves.toMatchObject({
        imageModels: catalogCount,
        availableImageModels: 1
      });
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('describes image models with official documentation details without opening a project', async () => {
    const server = new AxisAppServer();
    try {
      const detail = await server.describeImageModelForCli('gpt-image-2');

      expect(() => server.getSnapshot()).toThrow('No project session is open.');
      expect(detail.officialDocUrls).toContain('https://developers.openai.com/api/docs/guides/image-generation');
      expect(detail.officialSnapshotPath).toBe('packages/capability-runtime/src/imageModels/officialDocs/snapshots/openai/image-generation.md');
      expect(detail.officialCapturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(detail.descriptionMarkdown).toContain('# gpt-image-2');
      expect(detail.descriptionMarkdown).toContain('axis generate image <project> --input-json');
      expect(detail.descriptionMarkdown).toContain('"model":"gpt-image-2"');
      expect(detail.argumentsSchema).toHaveProperty('properties');
      expect('usageNotes' in detail).toBe(false);
    } finally {
      server.close();
    }
  });

  it('initializes projects only through the explicit CLI init method', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-app-server-cli-init-'));
    const server = new AxisAppServer();
    try {
      await expect(server.projectStatusForCli(root)).rejects.toThrow();

      const snapshot = await server.initProjectForCli(root);

      expect(snapshot.projectRoot).toBe(root);
      expect((server as unknown as { fileWatchHandle?: unknown }).fileWatchHandle).toBeUndefined();
      await expect(server.projectStatusForCli(root)).resolves.toMatchObject({
        projectRoot: root,
        health: { diagnosticCounts: { errors: 0 } }
      });
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not synchronize Flowmaps into Canvas files for CLI project status reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axis-app-server-cli-readonly-status-'));
    const server = new AxisAppServer();
    try {
      await server.initProjectForCli(root);
      await mkdir(join(root, 'production'), { recursive: true });
      await writeFile(join(root, 'production/story.md'), '# Story\n', 'utf8');
      await mkdir(join(root, '.axis/flowmaps'), { recursive: true });
      await writeFile(join(root, '.axis/flowmaps/production.draft.yaml'), [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "**/*.md"',
        ''
      ].join('\n'), 'utf8');
      await server.publishFlowmapDraftForProject(root, {
        sourceDraftPath: '.axis/flowmaps/production.draft.yaml'
      });

      const canvasPath = join(root, '.axis/canvases/production-map.json');
      const before = await readFile(canvasPath, 'utf8');

      await server.projectStatusForCli(root);

      await expect(readFile(canvasPath, 'utf8')).resolves.toBe(before);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('separates missing image model configuration from unknown image models', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-cli-image-config-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-cli-image-config-project-'));
    const server = new AxisAppServer({
      globalConfigStore: new GlobalConfigStore({ axisHome: home })
    });
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });

      await expect(server.runImageModelRequestForCli({
        model: '__missing_model__',
        arguments: { prompt: 'cover' }
      })).resolves.toMatchObject({
        status: 'error',
        error: { code: 'model_unavailable' }
      });

      await expect(server.runImageModelRequestForCli({
        model: 'gpt-image-2',
        arguments: { prompt: 'cover' }
      })).resolves.toMatchObject({
        status: 'error',
        error: { code: 'image_model_not_configured' }
      });
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns configuration errors when image model API keys are missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-cli-image-auth-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-cli-image-auth-project-'));
    const server = new AxisAppServer({
      globalConfigStore: new GlobalConfigStore({ axisHome: home })
    });
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await server.imageModelSaveSetting('gpt-image-2', {
        baseUrlOverride: 'https://api.openai.com/v1',
        providerModelIdOverride: 'gpt-image-2'
      });

      await expect(server.runImageModelRequestForCli({
        model: 'gpt-image-2',
        arguments: { prompt: 'cover' }
      })).resolves.toMatchObject({
        status: 'error',
        error: { code: 'image_model_not_configured' }
      });
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('separates missing video model configuration from unknown video models', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-cli-video-config-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-cli-video-config-project-'));
    const server = new AxisAppServer({
      globalConfigStore: new GlobalConfigStore({ axisHome: home })
    });
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });

      await expect(server.runVideoModelRequestForCli({
        model: '__missing_model__',
        arguments: { content: [{ type: 'text', text: 'camera move' }] }
      })).resolves.toMatchObject({
        status: 'error',
        error: { code: 'model_unavailable' }
      });

      await expect(server.runVideoModelRequestForCli({
        model: 'doubao-seedance-2-0-260128',
        arguments: { content: [{ type: 'text', text: 'camera move' }] }
      })).resolves.toMatchObject({
        status: 'error',
        error: { code: 'video_model_not_configured' }
      });
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns configuration errors when video model API keys are missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-cli-video-auth-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-cli-video-auth-project-'));
    const server = new AxisAppServer({
      globalConfigStore: new GlobalConfigStore({ axisHome: home })
    });
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await server.videoModelSaveSetting('doubao-seedance-2-0-260128', {
        baseUrlOverride: 'https://ark.example/api/v3',
        providerModelIdOverride: null
      });

      await expect(server.runVideoModelRequestForCli({
        model: 'doubao-seedance-2-0-260128',
        arguments: { content: [{ type: 'text', text: 'camera move' }] }
      })).resolves.toMatchObject({
        status: 'error',
        error: { code: 'video_model_not_configured' }
      });
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('runs runtime LLM requests without project output fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-cli-llm-runtime-home-'));
    const configStore = new GlobalConfigStore({ axisHome: home });
    const server = new AxisAppServer({ globalConfigStore: configStore });
    try {
      await server.llmSaveProviderSetting({
        id: 'openai-main',
        name: 'OpenAI Compatible',
        providerType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        modelIds: ['gpt-axis'],
        apiKey: 'sk-test'
      });
      await server.llmSetDefaultModelKey('openai-main:gpt-axis');

      const result = await server.runLlmRequestForCli({
        prompt: 'write',
        output_path: 'generated/outline.md'
      });

      expect(result).toMatchObject({
        status: 'error',
        error: {
          code: 'invalid_input',
          message: 'Unknown llm.request input field: output_path'
        }
      });
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
