import type {
  CanvasSettingsView,
  DiscoverLlmProviderModelsInput,
  DiscoverProviderModelsOutput,
  GeneratedAssetView,
  GeneratedAssetsView,
  GeneratedAssetMetadataLookup,
  ImageModelSettingsView,
  IntegrationSettingsView,
  LlmProviderSettingsView,
  ProjectHealthSummary,
  SaveImageModelSettingInput,
  SaveLlmProviderSettingInput,
  SaveVideoModelSettingInput,
  VideoModelSettingsView,
  WorkbenchEvent,
  WorkbenchApiClient,
  WorkbenchProjectFileOperationResult,
  WorkbenchProjectSessionSnapshot,
  WorkbenchProjectTextFile
} from '@debrute/app-protocol';
import type {
  CanvasFeedbackDocument,
  CanvasNodeLayerPatch,
  UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import { getDebruteShellApi, type DebruteShellApi } from './shellApi';

export interface HttpWorkbenchApiClientOptions {
  daemonUrl?: string;
  token?: string;
  fetch?: typeof fetch;
  shell?: DebruteShellApi;
}

interface OpenProjectResponse {
  projectId: string;
  snapshot: WorkbenchProjectSessionSnapshot;
}

export function createHttpWorkbenchApiClient(options: HttpWorkbenchApiClientOptions = {}): WorkbenchApiClient {
  const daemonUrl = trimTrailingSlash(options.daemonUrl ?? browserDaemonUrl());
  const token = options.token ?? browserToken();
  const transportFetch = options.fetch ?? fetch;
  const shell = () => options.shell ?? getDebruteShellApi();
  const eventClientId = browserEventClientId();

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (token) {
      headers['x-debrute-daemon-token'] = token;
    }
    const response = await transportFetch(`${daemonUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      throw new Error(await responseErrorMessage(response));
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return response.json() as Promise<T>;
  };

  let currentProjectId: string | undefined;
  let eventSource: EventSource | undefined;
  const eventListeners = new Set<(event: WorkbenchEvent) => void>();
  const projectPathFor = (projectId: string, path: string) => `/api/projects/${encodeURIComponent(projectId)}${path}`;
  const projectPath = (path: string) => {
    if (!currentProjectId) {
      throw new Error('Debrute project is not open.');
    }
    return projectPathFor(currentProjectId, path);
  };
  const setCurrentProjectId = async (projectId: string) => {
    currentProjectId = projectId;
    reconnectEventSource();
    await shell()?.bindProjectWindowToProject?.({ projectId });
  };
  const reconnectEventSource = () => {
    eventSource?.close();
    eventSource = undefined;
    if (!currentProjectId || eventListeners.size === 0) {
      return;
    }
    const eventUrl = new URL(`${daemonUrl}${projectPath('/events')}`);
    eventUrl.searchParams.set('clientId', eventClientId);
    eventSource = new EventSource(eventUrl.toString());
    eventSource.onmessage = (event) => {
      const parsed = JSON.parse(event.data) as WorkbenchEvent;
      for (const listener of eventListeners) {
        listener(parsed);
      }
    };
  };

  return {
    mode: 'web',
    chooseProjectRoot: async () => {
      const debruteShell = shell();
      if (!debruteShell) {
        throw new Error('Debrute desktop shell is unavailable.');
      }
      return debruteShell.chooseProjectRoot();
    },
    openProject: async (input) => {
      if ('projectId' in input) {
        const opened = await request<OpenProjectResponse>('GET', projectPathFor(input.projectId, ''));
        await setCurrentProjectId(opened.projectId);
        return opened;
      }
      const opened = await request<OpenProjectResponse>('POST', '/api/projects/open', { projectRoot: input.projectRoot });
      await setCurrentProjectId(opened.projectId);
      return opened;
    },
    getSnapshot: async () => (await request<OpenProjectResponse>('GET', projectPath(''))).snapshot,
    getProjectHealth: () => request<ProjectHealthSummary>('GET', projectPath('/health')),
    readProjectTextFile: (projectRelativePath) => request<WorkbenchProjectTextFile>('GET', projectPath(`/files/text/${encodeProjectPath(projectRelativePath)}`)),
    writeProjectTextFile: (projectRelativePath, content) => request<WorkbenchProjectTextFile>('PUT', projectPath(`/files/text/${encodeProjectPath(projectRelativePath)}`), { content }),
    getDesktopPlatform: async () => browserPlatform(),
    createProjectFile: (input) => request<WorkbenchProjectFileOperationResult>('POST', projectPath('/files'), { ...input, kind: 'file' }),
    createProjectDirectory: (input) => request<WorkbenchProjectFileOperationResult>('POST', projectPath('/files'), { ...input, kind: 'directory' }),
    renameProjectPath: (input) => request<WorkbenchProjectFileOperationResult>('PATCH', projectPath(`/files/path/${encodeProjectPath(input.projectRelativePath)}`), {
      operation: 'rename',
      name: input.name
    }),
    copyProjectPath: (input) => request<WorkbenchProjectFileOperationResult>('PATCH', projectPath(`/files/path/${encodeProjectPath(input.sourceProjectRelativePath)}`), {
      operation: 'copy',
      targetDirectoryProjectRelativePath: input.targetDirectoryProjectRelativePath
    }),
    moveProjectPath: (input) => request<WorkbenchProjectFileOperationResult>('PATCH', projectPath(`/files/path/${encodeProjectPath(input.sourceProjectRelativePath)}`), {
      operation: 'move',
      targetDirectoryProjectRelativePath: input.targetDirectoryProjectRelativePath
    }),
    trashProjectPath: async (input) => {
      const debruteShell = shell();
      if (!debruteShell?.trashProjectPath) {
        throw new Error('Delete requires the Debrute desktop shell.');
      }
      if (!currentProjectId) {
        throw new Error('Debrute project is not open.');
      }
      await debruteShell.trashProjectPath({
        projectId: currentProjectId,
        projectRelativePath: input.projectRelativePath,
        kind: input.kind
      });
      return {
        projectRelativePath: input.projectRelativePath,
        snapshot: await request<WorkbenchProjectSessionSnapshot>('POST', projectPath('/refresh'))
      };
    },
    deleteProjectPathPermanently: (input) => request<WorkbenchProjectFileOperationResult>('DELETE', projectPath(`/files/path/${encodeProjectPath(input.projectRelativePath)}`)),
    revealProjectPathInSystemFileManager: async (input) => {
      const debruteShell = shell();
      if (!debruteShell?.revealProjectPathInSystemFileManager) {
        throw new Error('System file manager reveal requires the Debrute desktop shell.');
      }
      if (!currentProjectId) {
        throw new Error('Debrute project is not open.');
      }
      return debruteShell.revealProjectPathInSystemFileManager({ ...input, projectId: currentProjectId });
    },
    lookupGeneratedAssetMetadata: (input) => request<GeneratedAssetMetadataLookup>('POST', projectPath('/generated-assets/lookup'), input),
    listGeneratedAssets: () => request<GeneratedAssetsView>('GET', projectPath('/generated-assets')),
    readGeneratedAsset: (assetId) => request<GeneratedAssetView>('GET', projectPath(`/generated-assets/${encodeURIComponent(assetId)}`)),
    readCanvasFeedback: () => request<CanvasFeedbackDocument>('GET', projectPath('/canvas-feedback')),
    updateCanvasFeedbackEntry: (input) => request<CanvasFeedbackDocument>('PATCH', projectPath('/canvas-feedback'), input),
    refreshProject: () => request<WorkbenchProjectSessionSnapshot>('POST', projectPath('/refresh')),
    updateCanvasNodeLayouts: (input) => request('PATCH', projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/node-layouts`), {
      nodeLayouts: input.nodeLayouts
    }),
    updateCanvasNodeLayers: (input) => request('PATCH', projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/node-layers`), {
      nodeLayers: input.nodeLayers,
      nodeProjectRelativePathsTopFirst: input.nodeProjectRelativePathsTopFirst
    }),
    llmGetSettings: () => request<LlmProviderSettingsView>('GET', '/api/settings/llm'),
    llmSaveProviderSetting: (input, providerId) => providerId
      ? request<LlmProviderSettingsView>('PUT', `/api/settings/llm/providers/${encodeURIComponent(providerId)}`, input)
      : request<LlmProviderSettingsView>('POST', '/api/settings/llm/providers', input),
    llmDeleteProviderSetting: (providerId) => request<LlmProviderSettingsView>('DELETE', `/api/settings/llm/providers/${encodeURIComponent(providerId)}`),
    llmSetDefaultModelKey: (modelKey) => request<LlmProviderSettingsView>('PUT', '/api/settings/llm/default-model', { modelKey }),
    llmDiscoverProviderModels: (input: DiscoverLlmProviderModelsInput, providerId?: string) => (
      request<DiscoverProviderModelsOutput>('POST', '/api/settings/llm/discover-models', { input, providerId })
    ),
    imageModelGetSettings: () => request<ImageModelSettingsView>('GET', '/api/models/image'),
    imageModelSaveSetting: (modelId: string, input: SaveImageModelSettingInput) => (
      request<ImageModelSettingsView>('PUT', `/api/models/image/${encodeURIComponent(modelId)}`, input)
    ),
    videoModelGetSettings: () => request<VideoModelSettingsView>('GET', '/api/models/video'),
    videoModelSaveSetting: (modelId: string, input: SaveVideoModelSettingInput) => (
      request<VideoModelSettingsView>('PUT', `/api/models/video/${encodeURIComponent(modelId)}`, input)
    ),
    integrationsListStatus: () => request<IntegrationSettingsView>('GET', '/api/integrations'),
    integrationsRescan: () => request<IntegrationSettingsView>('POST', '/api/integrations/rescan', {}),
    canvasSettingsGet: () => request<CanvasSettingsView>('GET', '/api/settings/canvas'),
    canvasSettingsSave: (input: CanvasSettingsView) => request<CanvasSettingsView>('PUT', '/api/settings/canvas', input),
    onEvent: (listener: (event: WorkbenchEvent) => void) => {
      eventListeners.add(listener);
      reconnectEventSource();
      return () => {
        eventListeners.delete(listener);
        if (eventListeners.size === 0) {
          eventSource?.close();
          eventSource = undefined;
          return;
        }
        reconnectEventSource();
      };
    }
  };
}

function browserDaemonUrl(): string {
  if (typeof window === 'undefined') {
    throw new Error('Debrute daemon URL must be provided outside a browser window.');
  }
  return window.location.origin;
}

function browserToken(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('debrute-token') ?? undefined;
  if (fromUrl) {
    params.delete('debrute-token');
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', nextUrl);
    return fromUrl;
  }
  return undefined;
}

function browserPlatform(): NodeJS.Platform {
  if (typeof navigator === 'undefined') {
    throw new Error('Debrute browser platform requires navigator.');
  }
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('mac')) return 'darwin';
  if (platform.includes('win')) return 'win32';
  return 'linux';
}

function browserEventClientId(): string {
  const key = 'debrute.webClientId';
  if (typeof window === 'undefined') {
    return `web:${crypto.randomUUID()}`;
  }
  const existing = window.sessionStorage.getItem(key);
  if (existing) {
    return existing;
  }
  const next = `web:${crypto.randomUUID()}`;
  window.sessionStorage.setItem(key, next);
  return next;
}

function encodeProjectPath(projectRelativePath: string): string {
  return projectRelativePath.split('/').map(encodeURIComponent).join('/');
}

async function responseErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `Debrute daemon request failed: ${response.status}`;
  }
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text;
  } catch {
    return text;
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
