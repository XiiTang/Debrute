import type {
  AddProjectPathToCanvasMapInput,
  AdobeBridgeStateView,
  AudioModelSettingsView,
  CanvasTextPreviewSourceAvailabilityResponse,
  CanvasVideoPreviewSourceResponse,
  DebruteProductState,
  DebruteRuntimeInfo,
  DebruteHttpErrorBody,
  DaemonProjectUploadImportPlan,
  GeneratedAssetView,
  GeneratedAssetsView,
  GeneratedAssetMetadataLookup,
  ImageModelSettingsView,
  IntegrationSettingsView,
  RunIntegrationOperationInput,
  RunIntegrationOperationResult,
  ProductUpdateApplyResult,
  ProjectHealthSummary,
  SaveCanvasTextPreviewSourceResult,
  SaveCanvasTextPreviewSourceInput,
  SaveAdobeBridgeSettingsInput,
  SaveAudioModelSettingInput,
  SaveImageModelSettingInput,
  SaveWorkbenchPreferencesInput,
  SaveVideoModelSettingInput,
  SendProjectFileToPhotoshopResult,
  TerminalEvent,
  TerminalEventSubscription,
  TerminalSessionList,
  TerminalSessionResult,
  UpdateCanvasTextViewportStateInput,
  UpdateCanvasVideoPlaybackStateInput,
  VideoModelSettingsView,
  WorkbenchEvent,
  WorkbenchApiClient,
  WorkbenchCanvasDocumentMutationResult,
  WorkbenchCanvasFeedbackMutationResult,
  WorkbenchCanvasManagementResult,
  WorkbenchCanvasResetLayoutResult,
  WorkbenchProjectOpenResult,
  WorkbenchProjectFileBatchOperationResult,
  WorkbenchProjectFileOperationResult,
  WorkbenchProjectPickerOpenResult,
  WorkbenchProjectRefreshResult,
  WorkbenchProjectSessionSnapshot,
  WorkbenchProjectTextFile,
  WorkbenchProjectTextFileWriteResult,
  WorkbenchProjectUploadImportInput,
  WorkbenchAddProjectPathToCanvasMapResult,
  WorkbenchPreferencesView,
  WorkbenchTitleBarState
} from '@debrute/app-protocol';
import type {
  CanvasFeedbackDocument,
  UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import { getDebruteShellApi, type DebruteShellApi } from './shellApi';

export interface HttpWorkbenchApiClientOptions {
  fetch?: typeof fetch;
  shell?: DebruteShellApi;
}

interface RevisionedProjectResponse {
  projectId: string;
  projectRevision: number;
}

class DebruteHttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details: Record<string, unknown> | undefined
  ) {
    super(message);
  }
}

export function createHttpWorkbenchApiClient(options: HttpWorkbenchApiClientOptions = {}): WorkbenchApiClient {
  const transportFetch = options.fetch ?? fetch;
  const shell = () => options.shell ?? getDebruteShellApi();
  const eventClientId = browserEventClientId();

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const response = await transportFetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      throw await responseError(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return response.json() as Promise<T>;
  };
  const requestFormData = async <T>(method: string, path: string, body: FormData): Promise<T> => {
    const response = await transportFetch(path, {
      method,
      body,
      credentials: 'same-origin'
    });
    if (!response.ok) {
      throw await responseError(response);
    }
    return response.json() as Promise<T>;
  };

  let currentProjectId: string | undefined;
  let currentProjectRevision: number | undefined;
  let globalEventSource: EventSource | undefined;
  let projectEventSource: EventSource | undefined;
  let globalEventSourceRequestId = 0;
  const eventListeners = new Set<(event: WorkbenchEvent) => void>();
  const projectPathFor = (projectId: string, path: string) => `/api/projects/${encodeURIComponent(projectId)}${path}`;
  const projectPath = (path: string) => {
    if (!currentProjectId) {
      throw new Error('Debrute project is not open.');
    }
    return projectPathFor(currentProjectId, path);
  };
  const rememberProjectRevision = (result: RevisionedProjectResponse): void => {
    currentProjectId = result.projectId;
    currentProjectRevision = result.projectRevision;
  };
  const rememberStaleProjectRevision = (error: unknown): void => {
    if (
      error instanceof DebruteHttpRequestError
      && error.code === 'stale_project_revision'
      && isRevisionedProjectResponse(error.details)
    ) {
      rememberProjectRevision(error.details);
    }
  };
  const revisionedBody = (body: object = {}): Record<string, unknown> => {
    if (currentProjectRevision === undefined) {
      throw new Error('Debrute project revision is not loaded.');
    }
    return {
      baseRevision: currentProjectRevision,
      ...body
    };
  };
  const requestRevisioned = async <T extends RevisionedProjectResponse>(
    method: string,
    path: string,
    body?: object
  ): Promise<T> => {
    try {
      const result = await request<T>(method, path, revisionedBody(body));
      rememberProjectRevision(result);
      return result;
    } catch (error) {
      rememberStaleProjectRevision(error);
      throw error;
    }
  };
  const setCurrentProject = async (projectId: string, projectRevision: number) => {
    currentProjectId = projectId;
    currentProjectRevision = projectRevision;
    reconnectProjectEventSource();
    await shell()?.bindProjectWindowToProject?.({ projectId });
  };
  const dispatchWorkbenchEvent = (event: WorkbenchEvent): void => {
    if ('projectId' in event && 'projectRevision' in event) {
      rememberProjectRevision(event);
    }
    for (const listener of eventListeners) {
      listener(event);
    }
  };
  const openWorkbenchEventSource = (url: string): EventSource => {
    const source = new EventSource(url);
    source.onmessage = (event) => {
      dispatchWorkbenchEvent(JSON.parse(event.data) as WorkbenchEvent);
    };
    return source;
  };
  const reconnectGlobalEventSource = (): void => {
    globalEventSourceRequestId += 1;
    const requestId = globalEventSourceRequestId;
    globalEventSource?.close();
    globalEventSource = undefined;
    if (eventListeners.size === 0) {
      return;
    }
    if (requestId !== globalEventSourceRequestId || eventListeners.size === 0) {
      return;
    }
    const eventUrl = new URL('/api/workbench/events', browserEventSourceBaseUrl());
    eventUrl.searchParams.set('clientId', eventClientId);
    globalEventSource = openWorkbenchEventSource(relativeUrlString(eventUrl));
  };
  const reconnectProjectEventSource = (): void => {
    projectEventSource?.close();
    projectEventSource = undefined;
    if (!currentProjectId || eventListeners.size === 0) {
      return;
    }
    const eventUrl = new URL(projectPath('/events'), browserEventSourceBaseUrl());
    eventUrl.searchParams.set('clientId', eventClientId);
    projectEventSource = openWorkbenchEventSource(relativeUrlString(eventUrl));
  };

  return {
    mode: 'web',
    clientId: eventClientId,
    adobeBridgeGetState: () => request<AdobeBridgeStateView>('GET', '/api/adobe-bridge'),
    adobeBridgeSaveSettings: (input: SaveAdobeBridgeSettingsInput) => request<AdobeBridgeStateView>('PUT', '/api/adobe-bridge/settings', input),
    adobeBridgeLinkPhotoshop: (input) => request<AdobeBridgeStateView>('POST', projectPath('/adobe-bridge/links'), input),
    adobeBridgeUnlinkPhotoshop: (adobeClientId) => request<AdobeBridgeStateView>(
      'DELETE',
      projectPath(`/adobe-bridge/links/${encodeURIComponent(adobeClientId)}`)
    ),
    sendProjectFileToPhotoshop: (input) => request<SendProjectFileToPhotoshopResult>(
      'POST',
      projectPath('/adobe-bridge/send-to-photoshop'),
      input
    ),
    openProject: async (input) => {
      if ('projectId' in input) {
        const opened = await request<WorkbenchProjectOpenResult>('GET', projectPathFor(input.projectId, ''));
        await setCurrentProject(opened.projectId, opened.projectRevision);
        return opened;
      }
      const opened = await request<WorkbenchProjectOpenResult>('POST', '/api/projects/open', { projectRoot: input.projectRoot });
      await setCurrentProject(opened.projectId, opened.projectRevision);
      return opened;
    },
    openProjectFromPicker: async () => {
      const result = await request<WorkbenchProjectPickerOpenResult>('POST', '/api/projects/open-picker');
      if (result.opened) {
        await setCurrentProject(result.projectId, result.projectRevision);
      }
      return result;
    },
    getWorkbenchTitleBarState: (input) => {
      const params = new URLSearchParams({ host: input.host });
      if (input.projectId) {
        params.set('projectId', input.projectId);
      }
      return request<WorkbenchTitleBarState>('GET', `/api/workbench/title-bar?${params.toString()}`);
    },
    clearRecentProjectRoots: () => request<{ ok: true }>('DELETE', '/api/workbench/recent-projects'),
    getProductState: () => request<DebruteProductState>('GET', '/api/runtime/product'),
    checkProductUpdate: () => request<DebruteProductState>('POST', '/api/runtime/product/update/check'),
    applyProductUpdate: () => request<ProductUpdateApplyResult>('POST', '/api/runtime/product/update/apply'),
    workbenchPreferencesGet: () => request<WorkbenchPreferencesView>('GET', '/api/settings/workbench-preferences'),
    workbenchPreferencesSave: (input: SaveWorkbenchPreferencesInput) => request<WorkbenchPreferencesView>('PUT', '/api/settings/workbench-preferences', input),
    getSnapshot: async () => {
      const result = await request<WorkbenchProjectRefreshResult>('GET', projectPath(''));
      rememberProjectRevision(result);
      return result;
    },
    getProjectHealth: () => request<ProjectHealthSummary>('GET', projectPath('/health')),
    listTerminalSessions: () => request<TerminalSessionList>('GET', projectPath('/terminals')),
    createTerminalSession: (input = {}) => request<TerminalSessionResult>('POST', projectPath('/terminals'), input),
    writeTerminalInput: (input) => request<{ ok: true }>(
      'POST',
      projectPath(`/terminals/${encodeURIComponent(input.terminalId)}/input`),
      { data: input.data }
    ),
    resizeTerminal: (input) => request<TerminalSessionResult>(
      'POST',
      projectPath(`/terminals/${encodeURIComponent(input.terminalId)}/resize`),
      { cols: input.cols, rows: input.rows }
    ),
    closeTerminalSession: (input) => request<{ ok: true }>(
      'DELETE',
      projectPath(`/terminals/${encodeURIComponent(input.terminalId)}`)
    ),
    subscribeTerminalEvents: (terminalId, listener, onError): TerminalEventSubscription => {
      const eventUrl = new URL(projectPath(`/terminals/${encodeURIComponent(terminalId)}/events`), browserEventSourceBaseUrl());
      const source = new EventSource(relativeUrlString(eventUrl));
      let streamClosed = false;
      source.addEventListener('terminal', (event) => {
        const terminalEvent = JSON.parse((event as MessageEvent).data) as TerminalEvent;
        if (terminalEvent.type === 'closed') {
          streamClosed = true;
        }
        listener(terminalEvent);
        if (terminalEvent.type === 'closed') {
          source.close();
        }
      });
      source.onerror = () => {
        if (streamClosed) {
          return;
        }
        onError?.(new Error('Terminal event stream failed.'));
      };
      return {
        close: () => {
          streamClosed = true;
          source.close();
        }
      };
    },
    readProjectTextFile: (projectRelativePath) => request<WorkbenchProjectTextFile>('GET', projectPath(`/files/text/${encodeProjectPath(projectRelativePath)}`)),
    writeProjectTextFile: (projectRelativePath, content) => requestRevisioned<WorkbenchProjectTextFileWriteResult>('PUT', projectPath(`/files/text/${encodeProjectPath(projectRelativePath)}`), { content }),
    saveCanvasTextPreviewSource: (input) => requestFormData<SaveCanvasTextPreviewSourceResult>(
      'POST',
      projectPath('/canvas-text-previews/source'),
      canvasTextPreviewSourceFormData(input)
    ),
  readCanvasTextPreviewSources: (input) => request<CanvasTextPreviewSourceAvailabilityResponse>(
      'POST',
      projectPath('/canvas-text-previews/sources'),
      input
    ),
    readCanvasVideoPreviewSources: (input) => request<CanvasVideoPreviewSourceResponse>(
      'POST',
      projectPath('/canvas-video-previews/sources'),
      input
    ),
    getDesktopPlatform: async () => (
      await request<DebruteRuntimeInfo>('GET', '/api/runtime')
    ).platform,
    createProjectFile: (input) => requestRevisioned<WorkbenchProjectFileOperationResult>('POST', projectPath('/files'), { ...input, kind: 'file' }),
    createProjectDirectory: (input) => requestRevisioned<WorkbenchProjectFileOperationResult>('POST', projectPath('/files'), { ...input, kind: 'directory' }),
    renameProjectPath: (input) => requestRevisioned<WorkbenchProjectFileOperationResult>('PATCH', projectPath(`/files/path/${encodeProjectPath(input.projectRelativePath)}`), {
      operation: 'rename',
      name: input.name
    }),
    copyProjectPaths: (input) => requestRevisioned<WorkbenchProjectFileBatchOperationResult>('POST', projectPath('/files/batch/copy'), input),
    moveProjectPaths: (input) => requestRevisioned<WorkbenchProjectFileBatchOperationResult>('POST', projectPath('/files/batch/move'), input),
    copyProjectAbsolutePaths: (input) => request<{ paths: string[] }>(
      'POST',
      projectPath('/files/path/batch/copy-path'),
      input
    ),
    trashProjectPaths: (input) => requestRevisioned<WorkbenchProjectFileBatchOperationResult>(
      'POST',
      projectPath('/files/path/batch/trash'),
      input
    ),
    deleteProjectPathsPermanently: (input) => requestRevisioned<WorkbenchProjectFileBatchOperationResult>('POST', projectPath('/files/batch/delete-permanently'), input),
    importExternalLocalProjectPaths: (input) => requestRevisioned<WorkbenchProjectFileBatchOperationResult>('POST', projectPath('/files/import/local'), input),
    importExternalProjectUploads: async (input) => {
      if (currentProjectRevision === undefined) {
        throw new Error('Debrute project revision is not loaded.');
      }
      try {
        const result = await requestFormData<WorkbenchProjectFileBatchOperationResult>(
          'POST',
          projectPath('/files/import/uploads'),
          uploadImportFormData(input, currentProjectRevision)
        );
        rememberProjectRevision(result);
        return result;
      } catch (error) {
        rememberStaleProjectRevision(error);
        throw error;
      }
    },
    revealProjectPathInSystemFileManager: (input) => request<{ ok: true }>(
      'POST',
      projectPath(`/files/path/${encodeProjectPath(input.projectRelativePath)}/reveal`),
      { kind: input.kind }
    ),
    lookupGeneratedAssetMetadata: (input) => request<GeneratedAssetMetadataLookup>('POST', projectPath('/generated-assets/lookup'), input),
    listGeneratedAssets: () => request<GeneratedAssetsView>('GET', projectPath('/generated-assets')),
    readGeneratedAsset: (assetId) => request<GeneratedAssetView>('GET', projectPath(`/generated-assets/${encodeURIComponent(assetId)}`)),
    readCanvasFeedback: () => request<CanvasFeedbackDocument>('GET', projectPath('/canvas-feedback')),
    updateCanvasFeedbackEntry: (input) => requestRevisioned<WorkbenchCanvasFeedbackMutationResult>('PATCH', projectPath('/canvas-feedback'), input),
    refreshProject: async () => {
      const result = await request<WorkbenchProjectRefreshResult>('POST', projectPath('/refresh'));
      rememberProjectRevision(result);
      return result;
    },
    createCanvas: () => requestRevisioned<WorkbenchCanvasManagementResult>('POST', projectPath('/canvases')),
    renameCanvas: (input) => requestRevisioned<WorkbenchCanvasManagementResult>(
      'PATCH',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}`),
      { operation: 'rename', name: input.name }
    ),
    deleteCanvas: (input) => requestRevisioned<WorkbenchCanvasManagementResult>(
      'DELETE',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}`)
    ),
    reorderCanvases: (input) => requestRevisioned<WorkbenchCanvasManagementResult>(
      'PUT',
      projectPath('/canvases/index'),
      input
    ),
    repairCanvasIndex: () => requestRevisioned<WorkbenchCanvasManagementResult>('POST', projectPath('/canvases/index/repair')),
    addProjectPathToCanvasMap: (input: AddProjectPathToCanvasMapInput) => requestRevisioned<WorkbenchAddProjectPathToCanvasMapResult>(
      'POST',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/canvas-map/project-paths`),
      { projectRelativePath: input.projectRelativePath }
    ),
    updateCanvasNodeLayouts: (input) => requestRevisioned<WorkbenchCanvasDocumentMutationResult>('PATCH', projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/node-layouts`), {
      nodeLayouts: input.nodeLayouts
    }),
    resetCanvasNodeLayouts: (input) => requestRevisioned<WorkbenchCanvasResetLayoutResult>(
      'POST',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/reset-layout`),
      'all' in input ? { all: true } : { pathRules: input.pathRules }
    ),
    updateCanvasNodeLayers: (input) => requestRevisioned<WorkbenchCanvasDocumentMutationResult>('PATCH', projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/node-layers`), {
      nodeProjectRelativePathsTopFirst: input.nodeProjectRelativePathsTopFirst
    }),
    updateCanvasVideoPlaybackState: (input: UpdateCanvasVideoPlaybackStateInput) => requestRevisioned<WorkbenchCanvasDocumentMutationResult>(
      'PATCH',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/video-playback`),
      { updates: input.updates }
    ),
    updateCanvasTextViewportState: async (input: UpdateCanvasTextViewportStateInput) => {
      const result = await request<WorkbenchCanvasDocumentMutationResult>(
        'PATCH',
        projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/text-viewport`),
        { updates: input.updates }
      );
      rememberProjectRevision(result);
      return result;
    },
    imageModelGetSettings: () => request<ImageModelSettingsView>('GET', '/api/models/image'),
    imageModelSaveSetting: (modelId: string, input: SaveImageModelSettingInput) => (
      request<ImageModelSettingsView>('PUT', `/api/models/image/${encodeURIComponent(modelId)}`, input)
    ),
    videoModelGetSettings: () => request<VideoModelSettingsView>('GET', '/api/models/video'),
    videoModelSaveSetting: (modelId: string, input: SaveVideoModelSettingInput) => (
      request<VideoModelSettingsView>('PUT', `/api/models/video/${encodeURIComponent(modelId)}`, input)
    ),
    audioModelGetSettings: () => request<AudioModelSettingsView>('GET', '/api/models/audio'),
    audioModelSaveSetting: (modelId: string, input: SaveAudioModelSettingInput) => (
      request<AudioModelSettingsView>('PUT', `/api/models/audio/${encodeURIComponent(modelId)}`, input)
    ),
    integrationsListStatus: () => request<IntegrationSettingsView>('GET', '/api/integrations'),
    integrationsRescan: () => request<IntegrationSettingsView>('POST', '/api/integrations/rescan', {}),
    integrationsRunOperation: (input: RunIntegrationOperationInput) => request<RunIntegrationOperationResult>(
      'POST',
      `/api/integrations/${encodeURIComponent(input.integrationId)}/${encodeURIComponent(input.operation)}`,
      {}
    ),
    onEvent: (listener: (event: WorkbenchEvent) => void) => {
      eventListeners.add(listener);
      reconnectGlobalEventSource();
      reconnectProjectEventSource();
      return () => {
        eventListeners.delete(listener);
        if (eventListeners.size === 0) {
          globalEventSourceRequestId += 1;
          globalEventSource?.close();
          projectEventSource?.close();
          globalEventSource = undefined;
          projectEventSource = undefined;
          return;
        }
        reconnectGlobalEventSource();
        reconnectProjectEventSource();
      };
    }
  };
}

function browserEventSourceBaseUrl(): string {
  return typeof window === 'undefined' ? 'http://debrute.local' : window.location.origin;
}

function relativeUrlString(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
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

function uploadImportFormData(input: WorkbenchProjectUploadImportInput, baseRevision: number): FormData {
  const formData = new FormData();
  const plan: DaemonProjectUploadImportPlan = {
    baseRevision,
    targetDirectoryProjectRelativePath: input.targetDirectoryProjectRelativePath,
    entries: input.entries.map((entry, index) => (
      entry.kind === 'file'
        ? {
            kind: 'file',
            projectRelativePath: entry.projectRelativePath,
            fileField: `file:${index}`
          }
        : {
            kind: 'directory',
            projectRelativePath: entry.projectRelativePath
          }
    )),
    ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite })
  };
  formData.append('plan', JSON.stringify(plan));
  input.entries.forEach((entry, index) => {
    if (entry.kind === 'file') {
      formData.append(`file:${index}`, entry.file);
    }
  });
  return formData;
}

function canvasTextPreviewSourceFormData(input: SaveCanvasTextPreviewSourceInput): FormData {
  const formData = new FormData();
  formData.append('metadata', JSON.stringify({
    canvasId: input.canvasId,
    projectRelativePath: input.projectRelativePath,
    fingerprint: input.fingerprint
  }));
  formData.append('source', input.sourcePng, 'source.png');
  return formData;
}

async function responseError(response: Response): Promise<DebruteHttpRequestError> {
  const text = await response.text();
  if (!text) {
    return new DebruteHttpRequestError(response.status, undefined, `Debrute daemon request failed: ${response.status}`, undefined);
  }
  try {
    const parsed = JSON.parse(text) as Partial<DebruteHttpErrorBody>;
    if (parsed.error?.message && parsed.error.code) {
      return new DebruteHttpRequestError(response.status, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    return new DebruteHttpRequestError(response.status, undefined, text, undefined);
  } catch {
    return new DebruteHttpRequestError(response.status, undefined, text, undefined);
  }
}

function isRevisionedProjectResponse(value: unknown): value is RevisionedProjectResponse {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { projectId?: unknown }).projectId === 'string'
    && typeof (value as { projectRevision?: unknown }).projectRevision === 'number';
}
