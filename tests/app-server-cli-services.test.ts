import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DebruteAppServer, DebruteGlobalRuntimeServer, GlobalConfigStore } from '../apps/app-server/src/index';
import { createImageModelCatalog, createVideoModelCatalog, type SecretsConfig, type VideoModelsConfig } from '@debrute/capability-runtime';

class CountingGlobalConfigStore extends GlobalConfigStore {
  readVideoModelsCount = 0;
  readSecretsCount = 0;

  override async readVideoModels(): Promise<VideoModelsConfig> {
    this.readVideoModelsCount += 1;
    return super.readVideoModels();
  }

  override async readSecrets(): Promise<SecretsConfig> {
    this.readSecretsCount += 1;
    return super.readSecrets();
  }

  resetCounts(): void {
    this.readVideoModelsCount = 0;
    this.readSecretsCount = 0;
  }
}

describe('DebruteAppServer CLI service methods', () => {
  it('exposes runtime model summaries without opening a project', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-model-summaries-home-'));
    const server = new DebruteAppServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home })
    });
    try {
      const imageModels = await server.listImageModelsForCli();
      const videoModels = await server.listVideoModelsForCli();

      expect(imageModels).toEqual([]);
      expect(videoModels).toEqual([]);
      expect(() => server.getSnapshot()).toThrow('No project session is open.');
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('lists only API-key configured video models with native parameter summaries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-video-list-parameters-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore });
    const server = new DebruteAppServer({ globalConfigStore: configStore });
    try {
      await expect(server.listVideoModelsForCli()).resolves.toEqual([]);
      await globalRuntime.videoModelSaveSetting('doubao-seedance-2-0-260128', {
        requestModelIdOverride: null,
        apiKey: 'sk-video'
      });

      const videoModels = await server.listVideoModelsForCli();

      expect(videoModels).toEqual([expect.objectContaining({
        id: 'doubao-seedance-2-0-260128',
        parameters: expect.objectContaining({
          prompt: expect.stringContaining('required'),
          intent: expect.stringContaining('reference'),
          references: expect.stringContaining('project file path'),
          resolution: expect.stringContaining('1080p')
        })
      })]);
    } finally {
      globalRuntime.close();
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('lists only API-key configured image models with original parameter summaries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-image-list-parameters-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore });
    const server = new DebruteAppServer({ globalConfigStore: configStore });
    try {
      await globalRuntime.imageModelSaveSetting('gpt-image-2', { requestModelIdOverride: null, apiKey: 'sk-image' });
      const imageModels = await server.listImageModelsForCli();

      expect(imageModels).toEqual([expect.objectContaining({
        id: 'gpt-image-2',
        parameters: expect.objectContaining({
          prompt: expect.stringContaining('required'),
          size: expect.stringContaining('WIDTHxHEIGHT'),
          image: expect.stringContaining('reference'),
          mask: expect.stringContaining('alpha channel')
        })
      })]);
    } finally {
      globalRuntime.close();
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports catalog image model count separately from API-key configured image models', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-runtime-status-image-count-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore });
    const server = new DebruteAppServer({ globalConfigStore: configStore });
    try {
      const catalogCount = createImageModelCatalog().listAll().length;
      await expect(server.runtimeStatusForCli()).resolves.toMatchObject({
        imageModels: catalogCount,
        availableImageModels: 0,
        diagnostics: 0
      });

      await globalRuntime.imageModelSaveSetting('gpt-image-2', {
        requestModelIdOverride: null,
        apiKey: 'sk-image'
      });

      await expect(server.runtimeStatusForCli()).resolves.toMatchObject({
        imageModels: catalogCount,
        availableImageModels: 1
      });
    } finally {
      globalRuntime.close();
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports catalog video model count separately from API-key configured video models', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-runtime-status-video-count-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore });
    const server = new DebruteAppServer({ globalConfigStore: configStore });
    try {
      const catalogCount = createVideoModelCatalog().listAll().length;
      await expect(server.runtimeStatusForCli()).resolves.toMatchObject({
        videoModels: catalogCount,
        availableVideoModels: 0
      });

      await globalRuntime.videoModelSaveSetting('doubao-seedance-2-0-260128', {
        requestModelIdOverride: null,
        apiKey: 'sk-video'
      });

      await expect(server.runtimeStatusForCli()).resolves.toMatchObject({
        videoModels: catalogCount,
        availableVideoModels: 1
      });
    } finally {
      globalRuntime.close();
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('describes image models with official documentation details without opening a project', async () => {
    const server = new DebruteAppServer();
    try {
      const detail = await server.describeImageModelForCli('gpt-image-2');

      expect(() => server.getSnapshot()).toThrow('No project session is open.');
      expect(detail.officialDocUrls).toContain('https://developers.openai.com/api/docs/guides/image-generation');
      expect(detail.officialSnapshotPath).toBe('packages/capability-runtime/src/imageModels/officialDocs/snapshots/openai/image-generation.md');
      expect(detail.officialCapturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(detail.descriptionMarkdown).toContain('# gpt-image-2');
      expect(detail.descriptionMarkdown).toContain('debrute generate image <project> --input-json');
      expect(detail.descriptionMarkdown).toContain('--timeout-ms');
      expect(detail.descriptionMarkdown).toContain('"model":"gpt-image-2"');
      expect(detail.argumentsSchema).toHaveProperty('properties');
    } finally {
      server.close();
    }
  });

  it('describes video models with official documentation details without opening a project', async () => {
    const server = new DebruteAppServer();
    try {
      const detail = await server.describeVideoModelForCli('doubao-seedance-2-0-260128');

      expect(() => server.getSnapshot()).toThrow('No project session is open.');
      expect(detail.officialDocUrls).toContain('https://www.volcengine.com/docs/82379/2291680');
      expect(detail.officialSnapshotPath).toBe('packages/capability-runtime/src/videoModels/officialDocs/snapshots/volcengine-ark/seedance-2.md');
      expect(detail.officialCapturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(detail.descriptionMarkdown).toContain('# doubao-seedance-2-0-260128');
      expect(detail.descriptionMarkdown).toContain('debrute generate video <project> --input-json');
      expect(detail.descriptionMarkdown).toContain('--timeout-ms');
      expect(detail.descriptionMarkdown).toContain('"prompt"');
      expect(JSON.stringify(detail.argumentsSchema)).not.toContain('"content"');
    } finally {
      server.close();
    }
  });

  it('initializes projects only through the explicit CLI init method', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-app-server-cli-init-'));
    const server = new DebruteAppServer();
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

  it('does not compile Canvas Maps into Canvas files for CLI project status reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-app-server-cli-readonly-status-'));
    const server = new DebruteAppServer();
    try {
      await server.initProjectForCli(root);
      await mkdir(join(root, 'production'), { recursive: true });
      await writeFile(join(root, 'production/story.md'), '# Story\n', 'utf8');
      await mkdir(join(root, '.debrute/canvas-maps'), { recursive: true });
      await writeFile(join(root, '.debrute/canvas-maps/canvas-1.yaml'), [
        'paths:',
        '  - production/**/*.md',
        ''
      ].join('\n'), 'utf8');
      await server.pushCanvasMapForProject(root, { canvasId: 'canvas-1' });

      const canvasPath = join(root, '.debrute/canvases/canvas-1.json');
      const before = await readFile(canvasPath, 'utf8');
      await writeFile(join(root, 'production/future.md'), '# Future\n', 'utf8');
      await writeFile(join(root, '.debrute/canvas-maps/canvas-1.yaml'), 'paths:\n  - production/*.md\n', 'utf8');

      const status = await server.projectStatusForCli(root);

      expect(status.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'project',
          severity: 'warning',
          code: 'document_drift',
          message: expect.stringContaining('Canvas Map has changes that have not been pushed')
        })
      ]));
      await expect(readFile(canvasPath, 'utf8')).resolves.toBe(before);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports invalid Canvas JSON as a project document diagnostic for CLI status reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-app-server-cli-invalid-canvas-json-'));
    const server = new DebruteAppServer();
    try {
      await server.initProjectForCli(root);
      const canvasPath = join(root, '.debrute/canvases/canvas-1.json');
      await writeFile(canvasPath, '{"schemaVersion":1,"id":"canvas-1","nodeElements":"bad"}\n', 'utf8');

      const status = await server.projectStatusForCli(root);

      expect(status.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'project',
          severity: 'error',
          code: 'document_invalid_pushed',
          filePath: canvasPath,
          entityId: 'canvas-1',
          message: expect.stringContaining('Invalid canvas document schema')
        })
      ]));
      expect(status.health.diagnosticCounts.errors).toBeGreaterThan(0);
      await expect(readFile(canvasPath, 'utf8')).resolves.toBe('{"schemaVersion":1,"id":"canvas-1","nodeElements":"bad"}\n');
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('separates missing image model configuration from unknown image models', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-image-config-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-cli-image-config-project-'));
    const server = new DebruteAppServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home })
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
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-image-auth-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-cli-image-auth-project-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore });
    const server = new DebruteAppServer({ globalConfigStore: configStore });
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await globalRuntime.imageModelSaveSetting('gpt-image-2', {
        requestModelIdOverride: 'gpt-image-2'
      });

      await expect(server.runImageModelRequestForCli({
        model: 'gpt-image-2',
        arguments: { prompt: 'cover' }
      })).resolves.toMatchObject({
        status: 'error',
        error: { code: 'image_model_not_configured' }
      });
    } finally {
      globalRuntime.close();
      server.close();
      await rm(home, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('separates missing video model configuration from unknown video models', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-video-config-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-cli-video-config-project-'));
    const server = new DebruteAppServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home })
    });
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });

      await expect(server.runVideoModelRequestForCli({
        model: '__missing_model__',
        arguments: { prompt: 'camera move' }
      })).resolves.toMatchObject({
        status: 'error',
        error: { code: 'model_unavailable' }
      });

      await expect(server.runVideoModelRequestForCli({
        model: 'doubao-seedance-2-0-260128',
        arguments: { prompt: 'camera move' }
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
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-video-auth-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-cli-video-auth-project-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore });
    const server = new DebruteAppServer({ globalConfigStore: configStore });
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await globalRuntime.videoModelSaveSetting('doubao-seedance-2-0-260128', {
        requestModelIdOverride: null
      });

      await expect(server.runVideoModelRequestForCli({
        model: 'doubao-seedance-2-0-260128',
        arguments: { prompt: 'camera move' }
      })).resolves.toMatchObject({
        status: 'error',
        error: { code: 'video_model_not_configured' }
      });
    } finally {
      globalRuntime.close();
      server.close();
      await rm(home, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('runs video generation through one executor-level configuration read', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-video-single-config-read-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-cli-video-single-config-read-project-'));
    const configStore = new CountingGlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore });
    const server = new DebruteAppServer({
      globalConfigStore: configStore,
      videoModelFetch: async (url, init) => {
        if (url.endsWith('/contents/generations/tasks')) {
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          expect(body).toMatchObject({
            model: 'doubao-seedance-2-0-260128',
            content: [{ type: 'text', text: 'camera move' }],
            watermark: false
          });
          return jsonResponse({ id: 'task-1' });
        }
        if (url.endsWith('/contents/generations/tasks/task-1')) {
          return jsonResponse({ status: 'succeeded', content: { video_url: 'https://files.example/video.mp4' } });
        }
        throw new Error(`Unexpected video model fetch: ${url}`);
      },
      remoteUrlLookup: async (hostname) => {
        expect(hostname).toBe('files.example');
        return [{ address: '93.184.216.34', family: 4 }];
      },
      remoteHttpTransport: async (input) => {
        expect(input.url).toBe('https://files.example/video.mp4');
        return new Response(new Uint8Array([0, 0, 0, 24]), {
          status: 200,
          headers: { 'content-type': 'video/mp4' }
        });
      }
    });
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await globalRuntime.videoModelSaveSetting('doubao-seedance-2-0-260128', {
        requestModelIdOverride: null,
        apiKey: 'sk-video'
      });
      configStore.resetCounts();

      await expect(server.runVideoModelRequestForCli({
        model: 'doubao-seedance-2-0-260128',
        arguments: { prompt: 'camera move', watermark: false }
      })).resolves.toMatchObject({
        status: 'ok',
        outputs: { model: 'doubao-seedance-2-0-260128' }
      });

      expect(configStore.readVideoModelsCount).toBe(1);
      expect(configStore.readSecretsCount).toBe(1);
    } finally {
      globalRuntime.close();
      server.close();
      await rm(home, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('runs runtime LLM requests without project output fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-llm-runtime-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore });
    const server = new DebruteAppServer({ globalConfigStore: configStore });
    try {
      await globalRuntime.llmSaveProviderSetting({
        id: 'openai-main',
        name: 'OpenAI Compatible',
        providerType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        modelIds: ['gpt-debrute'],
        apiKey: 'sk-test'
      });
      await globalRuntime.llmSetDefaultModelKey('openai-main:gpt-debrute');

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
      globalRuntime.close();
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
