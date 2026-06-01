import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { AxisAppServer, GlobalConfigStore } from '@axis/app-server';
import { CANVAS_DOCUMENT_SCHEMA_VERSION } from '@axis/canvas-core';

describe('app-server', () => {
  it('opens a project with current Canvas snapshot and health fields', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-'));
    const server = new AxisAppServer();
    try {
      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      expect(snapshot.canvases).toHaveLength(1);
      expect(snapshot.health.canvasCount).toBe(1);
      expect(snapshot.canvases[0]).toMatchObject({
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
        id: 'production-map',
        nodeElements: []
      });
      expect(snapshot.projections[0]).toMatchObject({
        canvasId: snapshot.canvases[0]!.id,
        nodes: []
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid canvas state without deleting or rewriting it', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-invalid-canvas-'));
    const server = new AxisAppServer();
    try {
      await mkdir(join(projectRoot, '.axis/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.axis/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: { name: 'Broken Canvas Project' }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.axis/canvases/production-map.json'), JSON.stringify({
        schemaVersion: 3,
        id: 'production-map',
        title: 'Production Map',
        nodeElements: [],
        annotations: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');

      await expect(server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      })).rejects.toThrow('Invalid canvas document schema');
      await expect(readFile(join(projectRoot, '.axis/canvases/production-map.json'), 'utf8')).resolves.toContain('"schemaVersion": 3');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reads missing Canvas feedback as an empty current-state document', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-feedback-empty-'));
    const server = new AxisAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      const feedback = await server.readCanvasFeedback();

      expect(feedback).toMatchObject({
        schemaVersion: 1,
        entries: {}
      });
      expect(feedback.updatedAt).toEqual(expect.any(String));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('checks non-empty project files through the app-server boundary', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-project-file-exists-'));
    const server = new AxisAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      await mkdir(join(projectRoot, 'generated'), { recursive: true });
      await writeFile(join(projectRoot, 'generated/full.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'generated/empty.png'), '', 'utf8');

      await expect(server.projectFileExistsWithContent({ projectRelativePath: 'generated/full.png' })).resolves.toBe(true);
      await expect(server.projectFileExistsWithContent({ projectRelativePath: 'generated/empty.png' })).resolves.toBe(false);
      await expect(server.projectFileExistsWithContent({ projectRelativePath: 'generated/missing.png' })).resolves.toBe(false);
      await expect(server.projectFileExistsWithContent({ projectRelativePath: '../outside.png' })).rejects.toThrow('Project path must not contain "." or ".." segments');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('mutates project files and returns refreshed snapshots', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-file-ops-'));
    const server = new AxisAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      const directory = await server.createProjectDirectory({ parentProjectRelativePath: '', name: 'briefs' });
      expect(directory.projectRelativePath).toBe('briefs');
      expect(directory.kind).toBe('directory');
      expect(directory.snapshot.files.map((file) => file.projectRelativePath)).toContain('briefs');

      const file = await server.createProjectFile({ parentProjectRelativePath: 'briefs', name: 'concept.md' });
      expect(file.projectRelativePath).toBe('briefs/concept.md');
      expect(file.kind).toBe('file');
      expect(file.snapshot.files.map((entry) => entry.projectRelativePath)).toContain('briefs/concept.md');

      const renamed = await server.renameProjectPath({ projectRelativePath: 'briefs/concept.md', name: 'outline.md' });
      expect(renamed.projectRelativePath).toBe('briefs/outline.md');
      expect(renamed.snapshot.files.map((entry) => entry.projectRelativePath)).toContain('briefs/outline.md');

      const copied = await server.copyProjectPath({
        sourceProjectRelativePath: 'briefs/outline.md',
        targetDirectoryProjectRelativePath: 'briefs'
      });
      expect(copied.projectRelativePath).toBe('briefs/outline copy.md');

      const moved = await server.moveProjectPath({
        sourceProjectRelativePath: 'briefs/outline copy.md',
        targetDirectoryProjectRelativePath: ''
      });
      expect(moved.projectRelativePath).toBe('outline copy.md');
      expect(moved.snapshot.files.map((entry) => entry.projectRelativePath)).toContain('outline copy.md');

      const deleted = await server.deleteProjectPathPermanently({ projectRelativePath: 'outline copy.md' });
      expect(deleted.projectRelativePath).toBe('outline copy.md');
      expect(deleted.snapshot.files.map((entry) => entry.projectRelativePath)).not.toContain('outline copy.md');
      await expect(stat(join(projectRoot, 'outline copy.md'))).rejects.toThrow();
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reads, saves, and emits Canvas settings', async () => {
    const axisHome = await mkdtemp(join(tmpdir(), 'axis-app-server-canvas-settings-home-'));
    const server = new AxisAppServer({
      globalConfigStore: new GlobalConfigStore({ axisHome })
    });
    const events: unknown[] = [];
    const unsubscribe = server.onEvent((event) => events.push(event));
    try {
      await expect(server.canvasSettingsGet()).resolves.toEqual({
        imagePreviewsEnabled: true
      });

      const saved = await server.canvasSettingsSave({ imagePreviewsEnabled: false });

      expect(saved).toEqual({ imagePreviewsEnabled: false });
      await expect(readJson(join(axisHome, 'config/canvas_settings.json'))).resolves.toEqual({
        imagePreviewsEnabled: false
      });
      expect(events).toEqual([{
        type: 'canvas.settings.changed',
        settings: { imagePreviewsEnabled: false }
      }]);
    } finally {
      unsubscribe();
      server.close();
      await rm(axisHome, { recursive: true, force: true });
    }
  });

  it('rejects invalid Canvas settings input instead of normalizing it', async () => {
    const axisHome = await mkdtemp(join(tmpdir(), 'axis-app-server-canvas-settings-invalid-home-'));
    const server = new AxisAppServer({
      globalConfigStore: new GlobalConfigStore({ axisHome })
    });
    const events: unknown[] = [];
    const unsubscribe = server.onEvent((event) => events.push(event));
    try {
      await expect(server.canvasSettingsSave({ imagePreviewsEnabled: 'yes' } as never)).rejects.toThrow('Canvas imagePreviewsEnabled must be a boolean.');
      await expect(readJson(join(axisHome, 'config/canvas_settings.json'))).rejects.toThrow();
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
      server.close();
      await rm(axisHome, { recursive: true, force: true });
    }
  });

  it('rejects extra Canvas settings keys', async () => {
    const axisHome = await mkdtemp(join(tmpdir(), 'axis-app-server-canvas-settings-extra-home-'));
    const server = new AxisAppServer({
      globalConfigStore: new GlobalConfigStore({ axisHome })
    });
    const events: unknown[] = [];
    const unsubscribe = server.onEvent((event) => events.push(event));
    try {
      await expect(server.canvasSettingsSave({
        imagePreviewsEnabled: true,
        unknownPreviewMode: false
      } as never)).rejects.toThrow('Canvas settings must contain only imagePreviewsEnabled.');
      await expect(readJson(join(axisHome, 'config/canvas_settings.json'))).rejects.toThrow();
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
      server.close();
      await rm(axisHome, { recursive: true, force: true });
    }
  });

  it('writes, preserves, and clears Canvas feedback entries', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-feedback-write-'));
    const server = new AxisAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      const first = await server.updateCanvasFeedbackEntry({
        projectRelativePath: 'flow/a.png',
        marks: ['cross', 'like'],
        note: '  Keep A.  '
      });
      const second = await server.updateCanvasFeedbackEntry({
        projectRelativePath: 'flow/b.png',
        marks: ['needs_revision'],
        note: ''
      });
      const cleared = await server.updateCanvasFeedbackEntry({
        projectRelativePath: 'flow/a.png',
        marks: [],
        note: '   '
      });

      expect(first.entries['flow/a.png']).toMatchObject({
        projectRelativePath: 'flow/a.png',
        marks: ['like', 'cross'],
        note: 'Keep A.'
      });
      expect(second.entries['flow/a.png']).toBeDefined();
      expect(second.entries['flow/b.png']).toMatchObject({
        marks: ['needs_revision'],
        note: ''
      });
      expect(cleared.entries['flow/a.png']).toBeUndefined();
      expect(cleared.entries['flow/b.png']).toMatchObject({
        projectRelativePath: 'flow/b.png',
        marks: ['needs_revision'],
        note: ''
      });
      expect(await readJson(join(projectRoot, '.axis/reviews/canvas-feedback.json'))).toEqual(cleared);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('preserves all Canvas feedback entries from overlapping writes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-feedback-concurrent-'));
    const server = new AxisAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      await Promise.all(Array.from({ length: 8 }, async (_item, index) => {
        await server.updateCanvasFeedbackEntry({
          projectRelativePath: `flow/${index}.png`,
          marks: ['like'],
          note: `Option ${index}`
        });
      }));

      const feedback = await server.readCanvasFeedback();

      expect(Object.keys(feedback.entries).sort()).toEqual([
        'flow/0.png',
        'flow/1.png',
        'flow/2.png',
        'flow/3.png',
        'flow/4.png',
        'flow/5.png',
        'flow/6.png',
        'flow/7.png'
      ]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not overwrite invalid Canvas feedback files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-feedback-invalid-'));
    const server = new AxisAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      const feedbackPath = join(projectRoot, '.axis/reviews/canvas-feedback.json');
      await mkdir(join(projectRoot, '.axis/reviews'), { recursive: true });
      await writeFile(feedbackPath, '{"schemaVersion":1,"entries":', 'utf8');

      await expect(server.updateCanvasFeedbackEntry({
        projectRelativePath: 'flow/a.png',
        marks: ['like'],
        note: ''
      })).rejects.toThrow();

      expect(await readFile(feedbackPath, 'utf8')).toBe('{"schemaVersion":1,"entries":');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid Canvas feedback storage paths', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-feedback-invalid-path-'));
    const server = new AxisAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      await writeFile(join(projectRoot, '.axis/reviews'), 'not a directory', 'utf8');

      await expect(server.readCanvasFeedback()).rejects.toThrow();
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects Canvas documents with invalid viewport zoom', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-invalid-viewport-'));
    const server = new AxisAppServer();
    try {
      await mkdir(join(projectRoot, '.axis/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.axis/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: { name: 'Invalid Viewport Project' }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.axis/canvases/production-map.json'), JSON.stringify({
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
        id: 'production-map',
        title: 'Production Map',
        nodeElements: [],
        annotations: [],
        viewport: { x: 0, y: 0, zoom: 0 },
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');

      await expect(server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      })).rejects.toThrow('Invalid canvas document schema');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects Canvas node elements with unsupported fields', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-unsupported-canvas-field-'));
    const server = new AxisAppServer();
    try {
      await mkdir(join(projectRoot, '.axis/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.axis/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: { name: 'Unsupported Canvas Field Project' }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.axis/canvases/production-map.json'), JSON.stringify({
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
        id: 'production-map',
        title: 'Production Map',
        nodeElements: [{
          projectRelativePath: 'generated/a.png',
          nodeKind: 'file',
          mediaKind: 'image',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          z: 0,
          visible: true,
          locked: false,
          unsupportedField: true
        }],
        annotations: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');

      await expect(server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      })).rejects.toThrow('Invalid canvas document schema');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects Canvas selections with unknown node ids', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-invalid-selection-'));
    const server = new AxisAppServer();
    try {
      await mkdir(join(projectRoot, '.axis/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.axis/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: { name: 'Invalid Selection Project' }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.axis/canvases/production-map.json'), JSON.stringify({
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
        id: 'production-map',
        title: 'Production Map',
        nodeElements: [],
        annotations: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        selection: { kind: 'node', id: 'unsupported-node-id' },
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');

      await expect(server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      })).rejects.toThrow('Invalid canvas document schema');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('accepts manual Canvas node layout mode in current Canvas JSON', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-manual-layout-'));
    const server = new AxisAppServer();
    try {
      await mkdir(join(projectRoot, '.axis/canvases'), { recursive: true });
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/generated/a.md'), 'fake', 'utf8');
      await writeFile(join(projectRoot, '.axis/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: { name: 'Manual Layout Project' }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.axis/canvases/production-map.json'), JSON.stringify({
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
        id: 'production-map',
        title: 'Production Map',
        nodeElements: [{
          projectRelativePath: 'image-production/generated/a.md',
          nodeKind: 'file',
          mediaKind: 'text',
          x: 9,
          y: 8,
          width: 7,
          height: 6,
          z: 0,
          visible: true,
          locked: false,
          layoutMode: 'manual'
        }],
        annotations: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "generated/a.md"',
        ''
      ]);
      await server.publishFlowmapDraftForProject(projectRoot, {
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });

      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      });

      expect(snapshot.canvases[0]?.nodeElements.find((node) => node.projectRelativePath === 'image-production/generated/a.md')).toMatchObject({ layoutMode: 'manual' });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects auto Canvas node layout mode in current Canvas JSON', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-auto-layout-mode-'));
    const server = new AxisAppServer();
    try {
      await mkdir(join(projectRoot, '.axis/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.axis/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: { name: 'Auto Layout Mode Project' }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.axis/canvases/production-map.json'), JSON.stringify({
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
        id: 'production-map',
        title: 'Production Map',
        nodeElements: [{
          projectRelativePath: 'generated/a.png',
          nodeKind: 'file',
          mediaKind: 'image',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          z: 0,
          visible: true,
          locked: false,
          layoutMode: 'auto'
        }],
        annotations: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');

      await expect(server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      })).rejects.toThrow('Invalid canvas document schema');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('creates the default Canvas based only on current Canvas JSON files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-default-canvas-json-only-'));
    const server = new AxisAppServer();
    try {
      await mkdir(join(projectRoot, '.axis/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.axis/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: {
          id: 'project-default-canvas-json-only',
          name: 'Default Canvas JSON Only',
          createdAt: '2026-05-25T10:30:00.000Z',
          updatedAt: '2026-05-25T10:30:00.000Z'
        }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.axis/canvases/old.yaml'), 'not a Canvas JSON file\n', 'utf8');

      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: true
      });

      expect(snapshot.canvases.map((canvas) => canvas.id)).toEqual(['production-map']);
      await expect(readFile(join(projectRoot, '.axis/canvases/production-map.json'), 'utf8')).resolves.toContain('"nodeElements": []');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns raw provider output from image model request failures', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-image-provider-error-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-image-provider-error-project-'));
    const originalHome = process.env.HOME;
    const server = new AxisAppServer({
      imageModelFetch: async () => new Response(JSON.stringify({
        error: { message: 'quota exceeded' }
      }), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      })
    });
    try {
      process.env.HOME = home;
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await server.imageModelSaveSetting('gpt-image-2', {
        baseUrlOverride: null,
        providerModelIdOverride: null,
        apiKey: 'sk-image'
      });

      const result = await server.runImageModelRequestForCli({
        model: 'gpt-image-2',
        arguments: { prompt: 'cover image' },
        timeoutMs: 25
      });

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error.code).toBe('request_failed');
        expect(result.outputs?.raw_provider_output).toContain('quota exceeded');
      }
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('saves LLM settings that make llm_request usable from persisted config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-llm-settings-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-llm-settings-project-'));
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    const server = new AxisAppServer();
    try {
      process.env.HOME = home;
      globalThis.fetch = async (url, init) => {
        expect(url).toBe('https://api.openai.com/v1/chat/completions');
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer sk-llm-test',
          'content-type': 'application/json'
        });
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'configured llm result' } }]
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      };
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });

      const initial = await server.llmGetSettings();
      expect(initial).toEqual({
        providers: [],
        availableModelKeys: [],
        defaultModelKey: null
      });

      await server.llmSaveProviderSetting({
        id: 'openai-main',
        name: 'OpenAI Compatible',
        providerType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        modelIds: ['gpt-5.1'],
        apiKey: 'sk-llm-test'
      });
      const settings = await server.llmSetDefaultModelKey('openai-main:gpt-5.1');

      expect(settings).toMatchObject({
        defaultModelKey: 'openai-main:gpt-5.1',
        availableModelKeys: ['openai-main:gpt-5.1'],
        providers: [
          expect.objectContaining({
            id: 'openai-main',
            providerType: 'openai_compat',
            modelIds: ['gpt-5.1'],
            apiKeySet: true
          })
        ]
      });

      const result = await server.runLlmRequestForCli({ modelKey: 'default', prompt: 'Say hello.' });
      expect(result).toMatchObject({
        status: 'ok',
        outputs: {
          text: 'configured llm result',
          modelKey: 'openai-main:gpt-5.1'
        }
      });
    } finally {
      server.close();
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await rm(home, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects persisted LLM providers without a current providerType', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-llm-invalid-provider-type-home-'));
    try {
      const configStore = new GlobalConfigStore({ axisHome: home });
      await mkdir(configStore.paths().root, { recursive: true });
      await writeFile(configStore.paths().llmProvidersFile, JSON.stringify({
        providers: [{
          id: 'legacy-openai',
          name: 'Legacy OpenAI',
          baseUrl: 'https://api.example.test/v1',
          enabled: true,
          modelIds: ['model-a']
        }],
        defaultModelKey: 'legacy-openai:model-a'
      }, null, 2), 'utf8');

      await expect(configStore.readLlmProviders()).rejects.toThrow('LLM provider providerType must be "openai_compat" or "anthropic"');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('discovers OpenAI-compatible provider models from LLM settings input', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-llm-discovery-home-'));
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    const server = new AxisAppServer();
    try {
      process.env.HOME = home;
      globalThis.fetch = async (url, init) => {
        expect(url).toBe('https://api.example.test/v1/models');
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer sk-discovery-test'
        });
        return new Response(JSON.stringify({
          data: [
            { id: 'gpt-axis-a' },
            { id: 'gpt-axis-b' },
            { id: 'gpt-axis-a' }
          ]
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      };

      const result = await server.llmDiscoverProviderModels({
        id: 'openai-main',
        providerType: 'openai_compat',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-discovery-test'
      });

      expect(result).toEqual({
        endpoint: 'https://api.example.test/v1/models',
        models: ['gpt-axis-a', 'gpt-axis-b'],
        modelsCount: 2,
        supportsDiscovery: true
      });
    } finally {
      server.close();
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  it('saves media model routing overrides and derives configured state from API keys', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-media-model-settings-home-'));
    const originalHome = process.env.HOME;
    const server = new AxisAppServer();
    try {
      process.env.HOME = home;

      const imageSettings = await server.imageModelSaveSetting('gpt-image-2', {
        baseUrlOverride: 'not a url yet',
        providerModelIdOverride: 'custom-image-model',
        apiKey: 'sk-image'
      });
      const videoSettings = await server.videoModelSaveSetting('doubao-seedance-2-0-260128', {
        baseUrlOverride: 'ark local draft',
        providerModelIdOverride: 'custom-video-model',
        apiKey: 'sk-video'
      });

      expect(imageSettings.models.find((model) => model.axisModelId === 'gpt-image-2')).toMatchObject({
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultProviderModelId: 'gpt-image-2',
        baseUrlOverride: 'not a url yet',
        providerModelIdOverride: 'custom-image-model',
        apiKeySet: true
      });
      expect(videoSettings.models.find((model) => model.axisModelId === 'doubao-seedance-2-0-260128')).toMatchObject({
        defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        defaultProviderModelId: 'doubao-seedance-2-0-260128',
        baseUrlOverride: 'ark local draft',
        providerModelIdOverride: 'custom-video-model',
        apiKeySet: true
      });
      expect(imageSettings.models.some((model) => Object.prototype.hasOwnProperty.call(model, 'enabled'))).toBe(false);
      expect(imageSettings.models.some((model) => Object.prototype.hasOwnProperty.call(model, 'available'))).toBe(false);
      expect(videoSettings.models.some((model) => Object.prototype.hasOwnProperty.call(model, 'enabled'))).toBe(false);
      expect(videoSettings.models.some((model) => Object.prototype.hasOwnProperty.call(model, 'available'))).toBe(false);
    } finally {
      server.close();
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  it('stores API-key-only media settings only in secrets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axis-media-model-api-key-only-home-'));
    const configStore = new GlobalConfigStore({ axisHome: home });
    const server = new AxisAppServer({ globalConfigStore: configStore });
    try {
      const settings = await server.imageModelSaveSetting('gpt-image-2', {
        baseUrlOverride: null,
        providerModelIdOverride: null,
        apiKey: 'sk-image'
      });

      expect(settings.models.find((model) => model.axisModelId === 'gpt-image-2')).toMatchObject({
        baseUrlOverride: null,
        providerModelIdOverride: null,
        apiKeySet: true
      });
      await expect(configStore.readImageModels()).resolves.toEqual({ imageModels: [] });
      await expect(configStore.readSecrets()).resolves.toMatchObject({
        imageModelApiKeys: { 'gpt-image-2': 'sk-image' }
      });
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reads, writes, and projects Flowmap nodes on Canvas', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-flowmap-assets-'));
    const server = new AxisAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      await mkdir(join(projectRoot, '.axis/flowmaps'), { recursive: true });
      await mkdir(join(projectRoot, 'image-production/notes'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/notes/brief.md'), '# Brief\n', 'utf8');

      const textFile = await server.readProjectTextFile('image-production/notes/brief.md');
      const written = await server.writeProjectTextFile('image-production/notes/output.md', 'done\n');
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "notes/*.md"',
        ''
      ]);
      await server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });
      const snapshot = await server.refreshProject();

      expect(textFile.content).toBe('# Brief\n');
      expect(written.projectRelativePath).toBe('image-production/notes/output.md');
      await expect(readFile(join(projectRoot, 'image-production/notes/output.md'), 'utf8')).resolves.toBe('done\n');
      expect(snapshot.canvases[0]?.nodeElements.map((node) => [node.projectRelativePath, node.nodeKind, node.mediaKind])).toEqual([
        ['image-production', 'directory', undefined],
        ['image-production/notes', 'directory', undefined],
        ['image-production/notes/brief.md', 'file', 'text'],
        ['image-production/notes/output.md', 'file', 'text']
      ]);
      expect(snapshot.projections[0]?.nodes.find((node) => node.projectRelativePath === 'image-production/notes/brief.md')).toMatchObject({
        availability: { state: 'available', mimeType: 'text/markdown' }
      });
      expect(snapshot.projections[0]?.edges.map((edge) => [edge.sourceProjectRelativePath, edge.targetProjectRelativePath])).toEqual([
        ['image-production', 'image-production/notes'],
        ['image-production/notes', 'image-production/notes/brief.md'],
        ['image-production/notes', 'image-production/notes/output.md']
      ]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('refreshes project-visible ordinary file changes without requiring a Flowmap', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-refresh-'));
    const server = new AxisAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true
      });
      await mkdir(join(projectRoot, 'notes'), { recursive: true });
      await writeFile(join(projectRoot, 'notes/brief.md'), 'hello\n', 'utf8');
      const snapshot = await server.refreshProject();

      expect(snapshot.files.some((file) => file.projectRelativePath === 'notes/brief.md')).toBe(true);
      expect(snapshot.health.canvasCount).toBe(1);
      expect(snapshot.canvases[0]?.nodeElements).toEqual([]);
      expect(snapshot.diagnostics).toEqual([]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('applies visual-only Canvas updates without synchronizing Flowmaps', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-visual-canvas-'));
    let layoutReadsAllowed = true;
    let layoutReadCount = 0;
    const server = new AxisAppServer({
      canvasNodeLayoutSizeReader: async (input) => {
        layoutReadCount += 1;
        if (!layoutReadsAllowed) {
          throw new Error(`visual Canvas update synchronized Flowmaps for ${input.projectRelativePath}`);
        }
        if (input.nodeKind === 'directory') {
          return { width: 240, height: 96 };
        }
        if (input.mediaKind === 'text') {
          return { width: 420, height: 280 };
        }
        return { width: 320, height: 180 };
      }
    });
    try {
      await mkdir(join(projectRoot, '.axis/flowmaps'), { recursive: true });
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/generated/a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "generated/*.png"',
        ''
      ]);
      await server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });
      const synced = await server.refreshProject();
      const nodePath = 'image-production/generated/a.png';
      const checkedAt = synced.health.checkedAt;
      const files = synced.files;
      const events: string[] = [];
      const unsubscribe = server.onEvent((event) => events.push(event.type));

      layoutReadsAllowed = false;
      const layout = await server.updateCanvasNodeLayouts({
        canvasId: 'production-map',
        nodeLayouts: [{ projectRelativePath: nodePath, x: 50, y: 60, width: 640, height: 360 }]
      });
      const viewport = await server.updateCanvasViewport('production-map', { x: -120, y: 80, zoom: 1.5 });
      const selection = await server.updateCanvasSelection('production-map', { kind: 'node', projectRelativePath: nodePath });
      const layer = await server.updateCanvasNodeLayers({
        canvasId: 'production-map',
        nodeLayers: [{ projectRelativePath: nodePath, locked: true }]
      });
      unsubscribe();

      expect(layout.nodeElements.find((node) => node.projectRelativePath === nodePath)).toMatchObject({ x: 50, y: 60, width: 640, height: 360, layoutMode: 'manual' });
      expect(viewport.viewport).toEqual({ x: -120, y: 80, zoom: 1.5 });
      expect(selection.selection).toEqual({ kind: 'node', projectRelativePath: nodePath });
      expect(layer.nodeElements.find((node) => node.projectRelativePath === nodePath)).toMatchObject({ locked: true });
      expect(layoutReadCount).toBe(3);
      expect(events).toEqual(['canvas.changed', 'canvas.changed', 'canvas.changed', 'canvas.changed']);

      const snapshot = server.getSnapshot();
      expect(snapshot.files).toEqual(files);
      expect(snapshot.health.checkedAt).toBe(checkedAt);
      expect(snapshot.projections[0]!.nodes.find((node) => node.projectRelativePath === nodePath)).toMatchObject({
        x: 50,
        y: 60,
        width: 640,
        height: 360,
        locked: true,
        availability: { state: 'available' }
      });
      await expect(readFile(join(projectRoot, '.axis/canvases/production-map.json'), 'utf8')).resolves.toContain('"zoom": 1.5');
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('publishes Flowmap drafts to generated active YAML and leaves draft source editable', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-flowmap-publish-'));
    const server = new AxisAppServer();
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: false });
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - main',
        'include:',
        '  - "generated/**/*.png"',
        ''
      ]);
      const draftBefore = await readFile(join(projectRoot, '.axis/flowmaps/image-production.draft.yaml'), 'utf8');

      await expect(server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      })).resolves.toEqual({ ok: true, command: 'flowmap.publish' });

      const active = await readFile(join(projectRoot, '.axis/flowmaps/image-production.yaml'), 'utf8');
      const draft = await readFile(join(projectRoot, '.axis/flowmaps/image-production.draft.yaml'), 'utf8');
      expect(draft).toBe(draftBefore);
      expect(active).not.toBe(draft);
      expect(active).toContain('managed: true');
      expect(active).toContain('sourceDraft: .axis/flowmaps/image-production.draft.yaml');
      expect(active).toContain('contentHash: sha256:');
      expect(draft).not.toContain('contentHash: sha256:');
      expect(await readJson(join(projectRoot, '.axis/canvases/main.json'))).toMatchObject({
        id: 'main',
        nodeElements: []
      });
      await expect(readFile(join(projectRoot, 'image-production/.keep'), 'utf8')).rejects.toThrow();
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects Flowmap publish when the draft is missing', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-flowmap-create-default-'));
    const server = new AxisAppServer();
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: false });

      await expect(server.publishFlowmapDraftForProject(projectRoot, {
        sourceDraftPath: '.axis/flowmaps/new-map.draft.yaml'
      })).rejects.toMatchObject({ code: 'flowmap_draft_read_failed' });

      await expect(readFile(join(projectRoot, '.axis/flowmaps/new-map.yaml'), 'utf8')).rejects.toThrow();
      expect(await directoryExists(join(projectRoot, 'new-map'))).toBe(false);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects missing Flowmap drafts when active YAML already exists', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-flowmap-active-without-draft-'));
    const server = new AxisAppServer();
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: false });
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases: []',
        'include: []',
        ''
      ]);
      await server.publishFlowmapDraftForProject(projectRoot, {
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });
      await rm(join(projectRoot, '.axis/flowmaps/image-production.draft.yaml'), { force: true });
      const activeBefore = await readFile(join(projectRoot, '.axis/flowmaps/image-production.yaml'), 'utf8');

      await expect(server.publishFlowmapDraftForProject(projectRoot, {
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      })).rejects.toMatchObject({ code: 'flowmap_draft_read_failed' });
      await expect(readFile(join(projectRoot, '.axis/flowmaps/image-production.yaml'), 'utf8')).resolves.toBe(activeBefore);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects Flowmap publish from non-canonical draft paths', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-flowmap-draft-path-'));
    const server = new AxisAppServer();
    try {
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await mkdir(join(projectRoot, 'drafts'), { recursive: true });
      await writeFile(join(projectRoot, 'drafts/image-production.draft.yaml'), [
        'schemaVersion: 1',
        'canvases: []',
        'include: []',
        ''
      ].join('\n'), 'utf8');

      await expect(server.publishFlowmapDraft({
        sourceDraftPath: 'drafts/image-production.draft.yaml'
      })).rejects.toMatchObject({
        code: 'flowmap_invalid_draft_path'
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('syncs active Flowmaps into Canvas JSON when matching files appear', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-flowmap-sync-'));
    const server = new AxisAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'image-production/generated/a.png': { width: 320, height: 180 }
      })
    });
    try {
      await mkdir(join(projectRoot, '.axis/flowmaps'), { recursive: true });
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/generated/a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "generated/**/*.png"',
        ''
      ]);
      await server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });
      const snapshot = await server.refreshProject();

      expect(snapshot.canvases[0]!.nodeElements.map((node) => [node.projectRelativePath, node.nodeKind, node.mediaKind])).toEqual([
        ['image-production', 'directory', undefined],
        ['image-production/generated', 'directory', undefined],
        ['image-production/generated/a.png', 'file', 'image']
      ]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('marks only large still raster images as Canvas-previewable in node availability', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-image-previewability-'));
    const server = new AxisAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'image-production/generated/large-still.png': { width: 900, height: 700 },
        'image-production/generated/small-still.png': { width: 320, height: 180 },
        'image-production/generated/animated.gif': { width: 320, height: 180 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(
        join(projectRoot, 'image-production/generated/large-still.png'),
        await largePreviewablePngBuffer()
      );
      await sharp({
        create: {
          width: 320,
          height: 180,
          channels: 4,
          background: '#336699ff'
        }
      }).png().toFile(join(projectRoot, 'image-production/generated/small-still.png'));
      await writeFile(join(projectRoot, 'image-production/generated/animated.gif'), 'gif placeholder', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "generated/*.png"',
        '  - "generated/*.gif"',
        ''
      ]);
      await server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });

      const nodes = (await server.refreshProject()).projections[0]!.nodes;

      expect(nodes.find((node) => node.projectRelativePath === 'image-production/generated/large-still.png')).toMatchObject({
        availability: { state: 'available', mimeType: 'image/png', canvasImagePreviewable: true, canvasImagePreviewSourceWidth: 900 }
      });
      expect(nodes.find((node) => node.projectRelativePath === 'image-production/generated/small-still.png')).toMatchObject({
        availability: { state: 'available', mimeType: 'image/png', canvasImagePreviewable: false }
      });
      expect(nodes.find((node) => node.projectRelativePath === 'image-production/generated/animated.gif')).toMatchObject({
        availability: { state: 'available', mimeType: 'image/gif', canvasImagePreviewable: false }
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('surfaces large raster metadata failures instead of falling back to original image mode', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-image-preview-metadata-error-'));
    const server = new AxisAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'image-production/generated/broken.png': { width: 900, height: 700 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/generated/broken.png'), Buffer.alloc(1_600_000, 1));
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "generated/*.png"',
        ''
      ]);
      await server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });

      const nodes = (await server.refreshProject()).projections[0]!.nodes;

      expect(nodes.find((node) => node.projectRelativePath === 'image-production/generated/broken.png')).toMatchObject({
        availability: {
          state: 'unreadable',
          message: 'Canvas image preview metadata could not be read: image-production/generated/broken.png'
        }
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('syncs Flowmap horizontal layout groups into Canvas JSON', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-flowmap-horizontal-groups-'));
    const server = new AxisAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'image-production/outputs/4k/a.png': { width: 100, height: 100 },
        'image-production/outputs/4k/b.png': { width: 200, height: 50 },
        'image-production/outputs/4k/c.png': { width: 80, height: 80 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'image-production/outputs/4k'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/outputs/4k/a.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'image-production/outputs/4k/b.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'image-production/outputs/4k/c.png'), 'fake', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "outputs/**/*.png"',
        'layout:',
        '  groups:',
        '    - directory: outputs/4k',
        '      include:',
        '        - "*.png"',
        ''
      ]);
      await server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });

      const snapshot = await server.refreshProject();

      expect(snapshot.canvases[0]?.nodeElements.find((node) => node.projectRelativePath === 'image-production/outputs/4k/a.png')).toMatchObject({ x: 1020, y: 0 });
      expect(snapshot.canvases[0]?.nodeElements.find((node) => node.projectRelativePath === 'image-production/outputs/4k/b.png')).toMatchObject({ x: 1200, y: 25 });
      expect(snapshot.canvases[0]?.nodeElements.find((node) => node.projectRelativePath === 'image-production/outputs/4k/c.png')).toMatchObject({ x: 1480, y: 10 });
      expect(snapshot.projections[0]?.edges.map((edge) => [edge.sourceProjectRelativePath, edge.targetProjectRelativePath])).toContainEqual([
        'image-production/outputs/4k',
        'image-production/outputs/4k/a.png'
      ]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('preserves manual node layout and removes absent Flowmap nodes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-flowmap-manual-'));
    const server = new AxisAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'image-production/generated/a.png': { width: 100, height: 100 },
        'image-production/generated/b.png': { width: 200, height: 50 },
        'image-production/generated/c.png': { width: 80, height: 80 }
      })
    });
    try {
      await mkdir(join(projectRoot, '.axis/flowmaps'), { recursive: true });
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/generated/b.png'), 'fake', 'utf8');
      await writeFile(join(projectRoot, 'image-production/generated/c.png'), 'fake', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "generated/*.png"',
        ''
      ]);
      await server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });
      await server.refreshProject();
      await server.updateCanvasNodeLayouts({
        canvasId: 'production-map',
        nodeLayouts: [{ projectRelativePath: 'image-production/generated/b.png', x: 999, y: 888, width: 777, height: 666 }]
      });
      await writeFile(join(projectRoot, 'image-production/generated/a.png'), 'fake', 'utf8');
      await rm(join(projectRoot, 'image-production/generated/c.png'), { force: true });

      const snapshot = await server.refreshProject();

      expect(snapshot.canvases[0]?.nodeElements.map((node) => [node.projectRelativePath, node.x, node.y, node.width, node.height, node.layoutMode])).toEqual([
        ['image-production', 0, 79.5, 240, 96, undefined],
        ['image-production/generated', 340, 79.5, 240, 96, undefined],
        ['image-production/generated/a.png', 680, 0, 100, 100, undefined],
        ['image-production/generated/b.png', 999, 888, 777, 666, 'manual']
      ]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports duplicate Flowmap layout group matches and preserves the last valid Canvas state', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-flowmap-horizontal-duplicate-'));
    const server = new AxisAppServer({
      canvasNodeLayoutSizeReader: canvasLayoutSizeReader({
        'image-production/outputs/a.png': { width: 100, height: 100 }
      })
    });
    try {
      await mkdir(join(projectRoot, 'image-production/outputs'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/outputs/a.png'), 'fake', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "outputs/*.png"',
        'layout:',
        '  groups:',
        '    - directory: outputs',
        '      include:',
        '        - "*.png"',
        ''
      ]);
      await server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });
      const validSnapshot = await server.refreshProject();
      expect(validSnapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual([
        'image-production',
        'image-production/outputs',
        'image-production/outputs/a.png'
      ]);

      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "outputs/*.png"',
        'layout:',
        '  groups:',
        '    - directory: outputs',
        '      include:',
        '        - "*.png"',
        '    - directory: outputs',
        '      include:',
        '        - "a.*"',
        ''
      ]);
      await server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });

      const snapshot = await server.refreshProject();

      expect(snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual([
        'image-production',
        'image-production/outputs',
        'image-production/outputs/a.png'
      ]);
      expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'flowmap',
          severity: 'error',
          code: 'flowmap_layout_group_duplicate_match',
          message: 'Flowmap layout groups match the same file more than once: image-production/outputs/a.png'
        })
      ]));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports invalid active Flowmaps and skips their nodes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-flowmap-invalid-'));
    const server = new AxisAppServer();
    try {
      await mkdir(join(projectRoot, '.axis/flowmaps'), { recursive: true });
      await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/generated/a.png'), 'fake', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "generated/*.png"',
        ''
      ]);
      await server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });
      await writeFile(join(projectRoot, '.axis/flowmaps/image-production.yaml'), `${await readFile(join(projectRoot, '.axis/flowmaps/image-production.yaml'), 'utf8')}unknown: true\n`, 'utf8');

      const snapshot = await server.refreshProject();

      expect(snapshot.canvases[0]?.nodeElements).toEqual([]);
      expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'flowmap',
          code: 'flowmap_invalid_yaml'
        })
      ]));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports unreadable media layout diagnostics without dropping valid Flowmap nodes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-flowmap-bad-media-'));
    const server = new AxisAppServer();
    try {
      await mkdir(join(projectRoot, '.axis/flowmaps'), { recursive: true });
      await mkdir(join(projectRoot, 'image-production'), { recursive: true });
      await writeFile(join(projectRoot, 'image-production/bad.png'), 'not a png', 'utf8');
      await writeFile(join(projectRoot, 'image-production/notes.txt'), 'usable text\n', 'utf8');
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - production-map',
        'include:',
        '  - "*"',
        ''
      ]);
      await server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });

      const snapshot = await server.refreshProject();

      expect(snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual([
        'image-production',
        'image-production/notes.txt'
      ]);
      expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'flowmap',
          code: 'flowmap_node_layout_unreadable',
          filePath: join(projectRoot, 'image-production/bad.png')
        })
      ]));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports missing Flowmap roots and missing mounted Canvas JSON', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-flowmap-missing-'));
    const server = new AxisAppServer();
    try {
      await mkdir(join(projectRoot, '.axis/flowmaps'), { recursive: true });
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true });
      await writeFlowmapDraft(projectRoot, 'image-production', [
        'schemaVersion: 1',
        'canvases:',
        '  - missing-canvas',
        'include:',
        '  - "generated/*.png"',
        ''
      ]);
      await server.publishFlowmapDraft({
        sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml'
      });
      await rm(join(projectRoot, 'image-production'), { recursive: true, force: true });

      const missingRoot = await server.refreshProject();
      expect(missingRoot.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'flowmap_root_missing' })
      ]));

      await mkdir(join(projectRoot, 'image-production'), { recursive: true });
      await rm(join(projectRoot, '.axis/canvases/missing-canvas.json'), { force: true });
      const missingCanvas = await server.refreshProject();
      expect(missingCanvas.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'flowmap_canvas_missing' })
      ]));
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('accepts JSON-only Canvas projects as empty Canvas views', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-json-only-canvas-'));
    const server = new AxisAppServer();
    try {
      await mkdir(join(projectRoot, '.axis/canvases'), { recursive: true });
      await writeFile(join(projectRoot, '.axis/project.json'), JSON.stringify({
        schemaVersion: 1,
        project: {
          id: 'project-json-only',
          name: 'JSON Only Canvas',
          createdAt: '2026-05-23T10:30:00.000Z',
          updatedAt: '2026-05-23T10:30:00.000Z'
        }
      }, null, 2), 'utf8');
      await writeFile(join(projectRoot, '.axis/canvases/production-map.json'), JSON.stringify({
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
        id: 'production-map',
        title: 'Production Map',
        nodeElements: [],
        annotations: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        preferences: { showDiagnostics: true }
      }, null, 2), 'utf8');

      const snapshot = await server.openProject(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false
      });

      expect(snapshot.canvases[0]?.nodeElements).toEqual([]);
      expect(snapshot.projections[0]?.edges).toEqual([]);
      expect(snapshot.diagnostics).toEqual([]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function writeFlowmapDraft(projectRoot: string, flowmapId: string, lines: string[]): Promise<void> {
  await mkdir(join(projectRoot, '.axis/flowmaps'), { recursive: true });
  await writeFile(join(projectRoot, `.axis/flowmaps/${flowmapId}.draft.yaml`), lines.join('\n'), 'utf8');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function largePreviewablePngBuffer(): Promise<Buffer> {
  const width = 900;
  const height = 700;
  return sharp(randomBytes(width * height * 3), {
    raw: {
      width,
      height,
      channels: 3
    }
  }).png().toBuffer();
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function canvasLayoutSizeReader(sizes: Record<string, { width: number; height: number }>) {
  return async (input: { projectRelativePath: string; nodeKind: string; mediaKind: string }) => {
    if (input.nodeKind === 'directory') {
      return { width: 240, height: 96 };
    }
    if (input.mediaKind === 'text') {
      return { width: 420, height: 280 };
    }
    if (input.mediaKind === 'audio') {
      return { width: 320, height: 96 };
    }
    if (input.mediaKind === 'unknown') {
      return { width: 260, height: 120 };
    }
    const size = sizes[input.projectRelativePath];
    if (!size) {
      throw new Error(`missing test dimensions: ${input.projectRelativePath}`);
    }
    return size;
  };
}
