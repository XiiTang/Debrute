import type {
  AddProjectPathToCanvasMapInput,
  AdobeBridgeStateView,
  CanvasTextPreviewSourceAvailabilityResponse,
  CanvasVideoPreviewSourceResponse,
  DebruteGlobalSettingsView,
  DebruteProductState,
  DebruteRuntimeInfo,
  DebruteHttpErrorBody,
  DaemonProjectUploadImportPlan,
  GeneratedAssetView,
  GeneratedAssetsView,
  GeneratedAssetMetadataLookup,
  IntegrationSettingsView,
  RunIntegrationOperationInput,
  RunIntegrationOperationResult,
  ProductUpdateApplyResult,
  ProjectHealthSummary,
  SaveCanvasTextPreviewSourceResult,
  SaveCanvasTextPreviewSourceInput,
  SaveDebruteGlobalSettingsInput,
  SendProjectFileToPhotoshopResult,
  TerminalEvent,
  TerminalEventSubscription,
  TerminalSessionList,
  TerminalSessionResult,
  UpdateCanvasTextViewportStateInput,
  UpdateCanvasVideoPlaybackStateInput,
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

interface ProjectRequestScope {
  projectId: string;
  generation: number;
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

class ProjectChangedRequestError extends Error {}

class ProjectResponseSupersededError extends Error {
  readonly name = 'ProjectResponseSupersededError';

  constructor(
    readonly projectId: string,
    readonly responseRevision: number,
    readonly currentRevision: number
  ) {
    super(`Project response revision ${responseRevision} was superseded by revision ${currentRevision}.`);
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
  let currentProjectGeneration = 0;
  let projectOpenRequestSequence = 0;
  let latestAcceptedProjectOpenRequestId = 0;
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
  const captureProjectScope = (): ProjectRequestScope => {
    if (!currentProjectId) {
      throw new Error('Debrute project is not open.');
    }
    return {
      projectId: currentProjectId,
      generation: currentProjectGeneration
    };
  };
  const isCurrentProjectScope = (scope: ProjectRequestScope): boolean => (
    scope.projectId === currentProjectId && scope.generation === currentProjectGeneration
  );
  const rememberProjectRevision = (scope: ProjectRequestScope, result: RevisionedProjectResponse): void => {
    if (result.projectId !== scope.projectId) {
      throw new Error(`Project response ${result.projectId} does not match request project ${scope.projectId}.`);
    }
    if (currentProjectRevision !== undefined && result.projectRevision < currentProjectRevision) {
      throw new ProjectResponseSupersededError(scope.projectId, result.projectRevision, currentProjectRevision);
    }
    currentProjectRevision = result.projectRevision;
  };
  const rememberStaleProjectRevision = (scope: ProjectRequestScope, error: unknown): void => {
    if (
      error instanceof DebruteHttpRequestError
      && error.code === 'stale_project_revision'
      && isRevisionedProjectResponse(error.details)
      && error.details.projectId === scope.projectId
      && (currentProjectRevision === undefined || error.details.projectRevision > currentProjectRevision)
    ) {
      currentProjectRevision = error.details.projectRevision;
    }
  };
  const revisionedBody = (baseRevision: number, body: object = {}): Record<string, unknown> => {
    return {
      baseRevision,
      ...body
    };
  };
  let revisionedMutationQueue: Promise<void> = Promise.resolve();
  const runRevisionedMutation = <T extends RevisionedProjectResponse>(
    operation: (baseRevision: number) => Promise<T>
  ): Promise<T> => {
    const scope = captureProjectScope();
    const queued = revisionedMutationQueue.then(async () => {
      if (!isCurrentProjectScope(scope)) {
        throw new ProjectChangedRequestError('Project changed before the request started.');
      }
      if (currentProjectRevision === undefined) {
        throw new Error('Debrute project revision is not loaded.');
      }
      try {
        const result = await operation(currentProjectRevision);
        if (!isCurrentProjectScope(scope)) {
          throw new ProjectChangedRequestError('Project changed while the request was in flight.');
        }
        rememberProjectRevision(scope, result);
        return result;
      } catch (error) {
        if (!isCurrentProjectScope(scope)) {
          throw error instanceof ProjectChangedRequestError
            ? error
            : new ProjectChangedRequestError('Project changed while the request was in flight.');
        }
        rememberStaleProjectRevision(scope, error);
        throw error;
      }
    });
    revisionedMutationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  };
  const requestRevisioned = <T extends RevisionedProjectResponse>(
    method: string,
    path: string,
    body?: object
  ): Promise<T> => {
    return runRevisionedMutation((baseRevision) => request<T>(method, path, revisionedBody(baseRevision, body)));
  };
  const requestRevisionedProjectState = async <T extends RevisionedProjectResponse>(
    method: string,
    path: string
  ): Promise<T> => {
    const scope = captureProjectScope();
    try {
      const result = await request<T>(method, path);
      if (!isCurrentProjectScope(scope)) {
        throw new ProjectChangedRequestError('Project changed while the request was in flight.');
      }
      rememberProjectRevision(scope, result);
      return result;
    } catch (error) {
      if (!isCurrentProjectScope(scope)) {
        throw error instanceof ProjectChangedRequestError
          ? error
          : new ProjectChangedRequestError('Project changed while the request was in flight.');
      }
      throw error;
    }
  };
  const commitCurrentProject = (projectId: string, projectRevision: number): void => {
    currentProjectGeneration += 1;
    currentProjectId = projectId;
    currentProjectRevision = projectRevision;
    revisionedMutationQueue = Promise.resolve();
    reconnectProjectEventSource();
  };
  let projectOpenCommitQueue: Promise<void> = Promise.resolve();
  const acceptOpenedProject = <T extends RevisionedProjectResponse>(requestId: number, opened: T): Promise<T> => {
    if (requestId < latestAcceptedProjectOpenRequestId) {
      throw new ProjectChangedRequestError('Another project open request completed first.');
    }
    latestAcceptedProjectOpenRequestId = requestId;
    const committed = projectOpenCommitQueue.then(async () => {
      await shell()?.bindProjectWindowToProject?.({ projectId: opened.projectId });
      commitCurrentProject(opened.projectId, opened.projectRevision);
      return opened;
    });
    projectOpenCommitQueue = committed.then(() => undefined, () => undefined);
    return committed;
  };
  const dispatchWorkbenchEvent = (event: WorkbenchEvent): void => {
    if ('projectId' in event && 'projectRevision' in event) {
      if (event.projectId !== currentProjectId) {
        return;
      }
      if (currentProjectRevision !== undefined && event.projectRevision < currentProjectRevision) {
        return;
      }
      currentProjectRevision = event.projectRevision;
    }
    for (const listener of eventListeners) {
      listener(event);
    }
  };
  const openWorkbenchEventSource = (
    url: string,
    onEvent: (event: WorkbenchEvent) => void = dispatchWorkbenchEvent
  ): EventSource => {
    const source = new EventSource(url);
    source.onmessage = (event) => {
      onEvent(JSON.parse(event.data) as WorkbenchEvent);
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
    const scope = captureProjectScope();
    projectEventSource = openWorkbenchEventSource(relativeUrlString(eventUrl), (event) => {
      if (isCurrentProjectScope(scope) && 'projectId' in event && event.projectId === scope.projectId) {
        dispatchWorkbenchEvent(event);
      }
    });
  };

  return {
    mode: 'web',
    clientId: eventClientId,
    adobeBridgeGetState: () => request<AdobeBridgeStateView>('GET', '/api/adobe-bridge'),
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
      const requestId = projectOpenRequestSequence + 1;
      projectOpenRequestSequence = requestId;
      if ('projectId' in input) {
        const opened = await request<WorkbenchProjectOpenResult>('GET', projectPathFor(input.projectId, ''));
        return acceptOpenedProject(requestId, opened);
      }
      const opened = await request<WorkbenchProjectOpenResult>('POST', '/api/projects/open', { projectRoot: input.projectRoot });
      return acceptOpenedProject(requestId, opened);
    },
    openProjectFromPicker: async () => {
      const requestId = projectOpenRequestSequence + 1;
      projectOpenRequestSequence = requestId;
      const result = await request<WorkbenchProjectPickerOpenResult>('POST', '/api/projects/open-picker');
      if (result.opened) {
        return acceptOpenedProject(requestId, result);
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
    globalSettingsGet: () => request<DebruteGlobalSettingsView>('GET', '/api/settings/global'),
    globalSettingsSave: (input: SaveDebruteGlobalSettingsInput) => request<DebruteGlobalSettingsView>('PATCH', '/api/settings/global', input),
    getSnapshot: () => requestRevisionedProjectState<WorkbenchProjectRefreshResult>('GET', projectPath('')),
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
    importExternalProjectUploads: (input) => runRevisionedMutation((baseRevision) => (
      requestFormData<WorkbenchProjectFileBatchOperationResult>(
        'POST',
        projectPath('/files/import/uploads'),
        uploadImportFormData(input, baseRevision)
      )
    )),
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
    refreshProject: () => requestRevisionedProjectState<WorkbenchProjectRefreshResult>('POST', projectPath('/refresh')),
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
    bringCanvasNodeToFront: (input) => requestRevisioned<WorkbenchCanvasDocumentMutationResult>('POST', projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/node-stack-order/bring-to-front`), {
      projectRelativePath: input.projectRelativePath
    }),
    updateCanvasVideoPlaybackState: (input: UpdateCanvasVideoPlaybackStateInput) => requestRevisioned<WorkbenchCanvasDocumentMutationResult>(
      'PATCH',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/video-playback`),
      { updates: input.updates }
    ),
    updateCanvasTextViewportState: (input: UpdateCanvasTextViewportStateInput) => requestRevisioned<WorkbenchCanvasDocumentMutationResult>(
      'PATCH',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/text-viewport`),
      { updates: input.updates }
    ),
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
