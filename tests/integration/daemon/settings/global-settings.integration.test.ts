import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DaemonTestHarness,
  readDaemonSseChunkWithDeadline
} from '../../../helpers/daemonTestHarness.js';

const invalidLocaleMessage = 'Workbench locale must be "en" or "zh-CN".';
const invalidThemeMessage = 'Workbench theme preference must be "system", "dark", or "light".';
const invalidDefaultFrontendMessage = 'Global settings defaultFrontend must be "electron", "browser", or "runtime-only".';

describe('daemon runtime-owned global settings final contract', { tags: ['settings'] }, () => {
  it('loads and patches runtime-owned global settings through the tokened route', async () => {
    await using harness = await DaemonTestHarness.create();

    const initial = await harness.fetchOkJson<any>('/api/settings/global');
    expect(initial).toMatchObject({
      workbench: {
        locale: 'en',
        themePreference: 'system',
        defaultFrontend: 'electron'
      },
      chrome: { recentProjectRoots: [] },
      models: {
        image: { models: expect.any(Array) },
        video: { models: expect.any(Array) },
        audio: { models: expect.any(Array) }
      },
      integrations: {
        integrations: expect.any(Array),
        backends: expect.any(Array)
      },
      adobeBridge: {
        enabled: true
      }
    });

    const saved = await harness.fetchOkJson<any>('/api/settings/global', {
      method: 'PATCH',
      body: JSON.stringify({
        workbench: { locale: 'zh-CN', themePreference: 'light', defaultFrontend: 'browser' }
      })
    });

    expect(saved).toMatchObject({
      workbench: { locale: 'zh-CN', themePreference: 'light', defaultFrontend: 'browser' },
      chrome: { recentProjectRoots: [] }
    });
    await expect(readFile(join(harness.homePath, 'config', 'global_settings.json'), 'utf8'))
      .resolves.toContain('"defaultFrontend": "browser"');
    expect(JSON.stringify(saved)).not.toContain('ApiKeys');
  });

  it('maps invalid runtime-owned global settings patches to invalid_input', async () => {
    await using harness = await DaemonTestHarness.create();

    await expectPatchError(harness, { workbench: { locale: 'fr' } }, invalidLocaleMessage);
    await expectPatchError(harness, { workbench: { themePreference: 'solarized' } }, invalidThemeMessage);
    await expectPatchError(harness, { workbench: { defaultFrontend: 'native' } }, invalidDefaultFrontendMessage);
    await expectPatchError(harness, { models: { image: null } }, 'Global settings models.image must be an object.');
    await expectPatchError(harness, { adobeBridge: { enabled: 'yes' } }, 'Adobe Bridge config must contain enabled.');
    await expectPatchError(harness, {
      models: {
        image: {
          modelId: 'gpt-image-2',
          setting: {
            baseUrlOverride: 123,
            requestModelIdOverride: null
          }
        }
      }
    }, 'Image model baseUrlOverride must be a string or null.');
    await expectPatchError(harness, {
      models: {
        image: {
          modelId: 'missing-image-model',
          setting: {
            baseUrlOverride: null,
            requestModelIdOverride: null
          }
        }
      }
    }, 'Unknown image model: missing-image-model');
  });

  it('forwards global settings changes to the global Workbench event stream without opening a project', async () => {
    await using harness = await DaemonTestHarness.create();
    const stream = await WorkbenchEventStream.open(`${harness.daemonUrl}/api/workbench/events?clientId=test-client`, {
      headers: { 'x-debrute-daemon-token': harness.token }
    });
    try {
      const eventPromise = stream.next();
      await harness.fetchOkJson('/api/settings/global', {
        method: 'PATCH',
        body: JSON.stringify({ workbench: { locale: 'zh-CN', themePreference: 'dark', defaultFrontend: 'browser' } })
      });

      await expect(eventPromise).resolves.toMatchObject({
        type: 'globalSettings.changed',
        settings: {
          workbench: {
            locale: 'zh-CN',
            themePreference: 'dark',
            defaultFrontend: 'browser'
          }
        }
      });
    } finally {
      await stream.close();
    }
  });

  it('routes recent project changes through the root Workbench stream only', async () => {
    await using harness = await DaemonTestHarness.create();
    const firstProject = await harness.createProject();
    const secondProject = await harness.createProject();
    await writeFile(join(firstProject.rootPath, 'brief.md'), '# Initial', 'utf8');
    const root = await WorkbenchEventStream.open(`${harness.daemonUrl}/api/workbench/events`, {
      headers: { 'x-debrute-daemon-token': harness.token }
    });
    try {
      const firstOpened = await harness.fetchOkJson<{ projectId: string; projectRevision: number }>('/api/projects/open', {
        method: 'POST',
        body: JSON.stringify({ projectRoot: firstProject.rootPath })
      });
      await root.next((event) => (
        isRecord(event) && event.type === 'recentProjects.changed'
      ));
      const recentEvent = root.next((event) => (
        isRecord(event) && event.type === 'recentProjects.changed'
      ));
      await harness.fetchOkJson('/api/projects/open', {
        method: 'POST',
        body: JSON.stringify({ projectRoot: secondProject.rootPath })
      });
      await expect(recentEvent).resolves.toEqual({
        type: 'recentProjects.changed',
        recentProjectRoots: [await realpath(secondProject.rootPath), await realpath(firstProject.rootPath)]
      });

      const project = await WorkbenchEventStream.open(
        `${harness.daemonUrl}/api/projects/${firstOpened.projectId}/events`,
        { headers: { 'x-debrute-daemon-token': harness.token } }
      );
      try {
        const reopened = await harness.fetchOkJson<{ projectRevision: number }>('/api/projects/open', {
          method: 'POST',
          body: JSON.stringify({ projectRoot: firstProject.rootPath })
        });
        const nextProjectEvent = project.next();
        const textFile = await harness.fetchOkJson<{ revision: string }>(
          `/api/projects/${firstOpened.projectId}/files/text/brief.md`
        );
        await harness.fetchOkJson(`/api/projects/${firstOpened.projectId}/files/text/brief.md`, {
          method: 'PUT',
          body: JSON.stringify({
            baseRevision: reopened.projectRevision,
            content: '# Brief',
            expectedRevision: textFile.revision
          })
        });
        await expect(nextProjectEvent).resolves.toMatchObject({ type: 'project.fileChanged' });
      } finally {
        await project.close();
      }
    } finally {
      await root.close();
    }
  });

  it('returns a server error for malformed current settings', async () => {
    await using harness = await DaemonTestHarness.create();
    await mkdir(join(harness.homePath, 'config'), { recursive: true });
    await writeFile(join(harness.homePath, 'config', 'global_settings.json'), '{', 'utf8');

    const response = await harness.fetchJson('/api/settings/global');

    expect(response.status).toBe(500);
  });

  it('returns a server error for a broken current config path', async () => {
    await using harness = await DaemonTestHarness.create();
    await symlink(
      join(harness.homePath, 'missing-config-target'),
      join(harness.homePath, 'config'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const response = await harness.fetchJson<{ error: { code: string } }>('/api/settings/global', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workbench: { locale: 'zh-CN' } })
    });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      error: { code: 'internal_error' }
    });
  });

  it('returns complete integrations when the first global settings request is a patch', async () => {
    await using harness = await DaemonTestHarness.create();

    const saved = await harness.fetchOkJson<any>('/api/settings/global', {
      method: 'PATCH',
      body: JSON.stringify({ workbench: { locale: 'zh-CN' } })
    });

    expect(saved).toMatchObject({
      integrations: {
        integrations: expect.arrayContaining([expect.objectContaining({ integrationId: 'ffmpeg' })]),
        backends: expect.any(Array)
      }
    });
    expect(saved.integrations.integrations.length).toBeGreaterThan(0);
    expect(saved.integrations.backends.length).toBeGreaterThan(0);
  });

  it('applies adobeBridge global settings patches to the live plugin WebSocket state', async () => {
    await using harness = await DaemonTestHarness.create();
    await harness.fetchOkJson('/api/settings/global', {
      method: 'PATCH',
      body: JSON.stringify({ adobeBridge: { enabled: false } })
    });

    const socket = new WebSocket(`${harness.daemonUrl.replace(/^http:/, 'ws:')}/api/adobe-bridge/plugin/ws`);
    try {
      await onceOpen(socket);
      const message = onceMessage(socket);
      socket.send(JSON.stringify({
        type: 'hello',
        adobeClientId: 'photoshop-disabled-client',
        hostApp: 'photoshop',
        hostVersion: '27.0',
        documentCount: 1,
        activeDocumentTitle: 'Artwork.psd'
      }));

      await expect(message).resolves.toContain('adobe_bridge_disabled');
    } finally {
      await closeSocket(socket);
    }
  });

  it('forwards each Adobe Bridge settings change once to the global Workbench event stream', async () => {
    await using harness = await DaemonTestHarness.create();
    const stream = await WorkbenchEventStream.open(`${harness.daemonUrl}/api/workbench/events?clientId=test-client`, {
      headers: { 'x-debrute-daemon-token': harness.token }
    });
    try {
      const eventPromise = stream.next((event) => isRecord(event) && event.type === 'adobeBridge.state.changed');
      await harness.fetchOkJson('/api/settings/global', {
        method: 'PATCH',
        body: JSON.stringify({ adobeBridge: { enabled: false } })
      });

      await expect(eventPromise).resolves.toMatchObject({
        type: 'adobeBridge.state.changed',
        state: {
          settings: {
            enabled: false,
            discoveryStatus: 'disabled'
          }
        }
      });
      await harness.fetchOkJson('/api/settings/global', {
        method: 'PATCH',
        body: JSON.stringify({ workbench: { locale: 'zh-CN' } })
      });
      await expect(stream.next()).resolves.toMatchObject({
        type: 'globalSettings.changed',
        settings: { workbench: { locale: 'zh-CN' } }
      });
    } finally {
      await stream.close();
    }
  });

  it('does not emit Adobe live state events for a read-only state request', async () => {
    await using harness = await DaemonTestHarness.create();
    const stream = await WorkbenchEventStream.open(`${harness.daemonUrl}/api/workbench/events`, {
      headers: { 'x-debrute-daemon-token': harness.token }
    });
    try {
      await harness.fetchOkJson('/api/adobe-bridge');
      await harness.fetchOkJson('/api/settings/global', {
        method: 'PATCH',
        body: JSON.stringify({ workbench: { locale: 'zh-CN' } })
      });

      await expect(stream.next()).resolves.toMatchObject({
        type: 'globalSettings.changed',
        settings: { workbench: { locale: 'zh-CN' } }
      });
    } finally {
      await stream.close();
    }
  });

  it('projects Workbench client connections into Adobe live project state', async () => {
    await using harness = await DaemonTestHarness.create();
    const project = await harness.createProject();
    const root = await WorkbenchEventStream.open(`${harness.daemonUrl}/api/workbench/events`, {
      headers: { 'x-debrute-daemon-token': harness.token }
    });
    try {
      await harness.openProject(project);
      const connectedEvent = root.next((event) => hasAdobeProjectClientCount(event, project.projectId!, 1));
      const projectEvents = await WorkbenchEventStream.open(
        `${harness.daemonUrl}/api/projects/${project.projectId}/events`,
        { headers: { 'x-debrute-daemon-token': harness.token } }
      );
      let projectEventsClosed = false;
      try {
        await connectedEvent;

        const disconnectedEvent = root.next((event) => hasAdobeProjectClientCount(event, project.projectId!, 0));
        await projectEvents.close();
        projectEventsClosed = true;
        await disconnectedEvent;
      } finally {
        if (!projectEventsClosed) {
          await projectEvents.close();
        }
      }
    } finally {
      await root.close();
    }
  });

  it('routes Adobe live state only through the root Workbench stream', async () => {
    await using harness = await DaemonTestHarness.create();
    const project = await harness.createProject();
    await writeFile(join(project.rootPath, 'brief.md'), '# Initial', 'utf8');
    const opened = await harness.fetchOkJson<{ projectId: string; projectRevision: number }>('/api/projects/open', {
      method: 'POST',
      body: JSON.stringify({ projectRoot: project.rootPath })
    });
    project.projectId = opened.projectId;
    const root = await WorkbenchEventStream.open(`${harness.daemonUrl}/api/workbench/events`, {
      headers: { 'x-debrute-daemon-token': harness.token }
    });
    const projectEvents = await WorkbenchEventStream.open(
      `${harness.daemonUrl}/api/projects/${opened.projectId}/events`,
      { headers: { 'x-debrute-daemon-token': harness.token } }
    );
    try {
      const liveEvent = root.next((event) => (
        isRecord(event)
        && event.type === 'adobeBridge.state.changed'
        && isRecord(event.state)
        && isRecord(event.state.settings)
        && event.state.settings.enabled === false
      ));
      await harness.fetchOkJson('/api/settings/global', {
        method: 'PATCH',
        body: JSON.stringify({ adobeBridge: { enabled: false } })
      });
      await expect(liveEvent).resolves.toMatchObject({
        type: 'adobeBridge.state.changed',
        state: { settings: { enabled: false, discoveryStatus: 'disabled' } }
      });

      const textFile = await harness.fetchOkJson<{ revision: string }>(
        `/api/projects/${opened.projectId}/files/text/brief.md`
      );
      await harness.fetchOkJson(`/api/projects/${opened.projectId}/files/text/brief.md`, {
        method: 'PUT',
        body: JSON.stringify({
          baseRevision: opened.projectRevision,
          content: '# Brief',
          expectedRevision: textFile.revision
        })
      });
      await expect(projectEvents.next()).resolves.toMatchObject({ type: 'project.fileChanged' });
    } finally {
      await projectEvents.close();
      await root.close();
    }
  });
});

async function expectPatchError(harness: DaemonTestHarness, body: unknown, message: string): Promise<void> {
  const response = await harness.fetchJson<{ error: { code: string; message: string } }>('/api/settings/global', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({
    error: {
      code: 'invalid_input',
      message
    }
  });
}

class WorkbenchEventStream {
  static async open(url: string, init: RequestInit = {}): Promise<WorkbenchEventStream> {
    const controller = new AbortController();
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to open Workbench event stream: HTTP ${response.status}.`);
    }
    return new WorkbenchEventStream(controller, response.body.getReader());
  }

  private readonly decoder = new TextDecoder();
  private buffer = '';

  private constructor(
    private readonly controller: AbortController,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  ) {}

  async next(predicate: (event: unknown) => boolean = () => true): Promise<unknown> {
    while (true) {
      let parsed = parseFirstEvent(this.buffer);
      while (parsed) {
        this.buffer = this.buffer.slice(parsed.endIndex);
        if (predicate(parsed.event)) {
          return parsed.event;
        }
        parsed = parseFirstEvent(this.buffer);
      }
      const read = await readDaemonSseChunkWithDeadline(this.reader, 'Workbench event');
      if (read.done) {
        throw new Error('Workbench event stream ended before a matching event arrived.');
      }
      this.buffer += this.decoder.decode(read.value, { stream: true });
    }
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } finally {
      this.controller.abort();
      this.reader.releaseLock();
    }
  }
}

function parseFirstEvent(buffer: string): { event: unknown; endIndex: number } | undefined {
  const endIndex = buffer.indexOf('\n\n');
  if (endIndex < 0) {
    return undefined;
  }
  const dataLine = buffer.slice(0, endIndex).split('\n').find((line) => line.startsWith('data: '));
  return {
    event: dataLine ? JSON.parse(dataLine.slice('data: '.length)) : undefined,
    endIndex: endIndex + 2
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasAdobeProjectClientCount(event: unknown, projectId: string, count: number): boolean {
  if (
    !isRecord(event)
    || event.type !== 'adobeBridge.state.changed'
    || !isRecord(event.state)
    || !Array.isArray(event.state.projects)
  ) {
    return false;
  }
  return event.state.projects.some((project) => (
    isRecord(project)
    && project.projectId === projectId
    && project.connectedWorkbenchClientCount === count
  ));
}

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed to open.')), { once: true });
  });
}

function onceMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket message failed.')), { once: true });
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    socket.addEventListener('close', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed while closing.')), { once: true });
    socket.close(1000, 'test done');
  });
}
