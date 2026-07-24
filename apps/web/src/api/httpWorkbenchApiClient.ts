import type {
  AddProjectPathToCanvasMapInput,
  AdobeBridgeStateView,
  CanvasTextPreviewSourceAvailabilityResponse,
  CanvasVideoPreviewSourceResponse,
  DebruteGlobalSettingsView,
  DebruteProductState,
  DebruteHttpErrorBody,
  RuntimeProjectUploadImportPlan,
  GeneratedAssetMetadataLookup,
  RunIntegrationOperationInput,
  RunIntegrationOperationResult,
  SaveCanvasTextPreviewSourceResult,
  SaveCanvasTextPreviewSourceInput,
  SaveDebruteGlobalSettingsInput,
  SendProjectFileToPhotoshopResult,
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
  WorkbenchProjectTextFile,
  WorkbenchProjectTextFileWriteResult,
  WorkbenchFeedbackWorkingCopy,
  WorkbenchTextWorkingCopy,
  WorkbenchProjectUploadImportInput,
  WorkbenchAddProjectPathToCanvasMapResult,
  WriteProjectTextFileInput
} from '@debrute/app-protocol';
import {
  decodeWorkbenchEvent,
  decodeWorkbenchProjectConnectionFrame,
  isRecognizedWorkbenchEventFrame,
  isRecognizedWorkbenchProjectConnectionFrame
} from '@debrute/app-protocol';
import type { CanvasFeedbackDocument } from '@debrute/canvas-core';
import { readJsonSseStream } from './streamingSse.js';
import { createTerminalHubClient } from './terminalHubClient.js';
import { getDebruteShellApi } from './shellApi.js';
import {
  createWorkbenchProjectProjection,
  type WorkbenchProjectProjection
} from '../workbench/services/WorkbenchProjectProjection.js';

interface ProjectRequestScope {
  projectId: string;
  generation: number;
}

interface RevisionedProjectCommandResult {
  projectId: string;
  projectRevision: number;
}

export interface HttpWorkbenchApiClient extends WorkbenchApiClient {
  readonly projectProjection: WorkbenchProjectProjection;
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

interface GlobalSnapshotFrame {
  type: 'global.snapshot';
  globalRevision: number;
  snapshot: {
    settings: DebruteGlobalSettingsView;
    photoshop: AdobeBridgeStateView;
    product: DebruteProductState | null;
  };
}

interface ProjectBindingCommandResult {
  projectId: string;
  outcome: 'bound' | 'focused_existing_desktop';
}

type ProjectPickerCommandResult =
  | { opened: false }
  | ({ opened: true } & ProjectBindingCommandResult);

export function createHttpWorkbenchApiClient(): HttpWorkbenchApiClient {
  const terminalHub = createTerminalHubClient();
  const projectProjection = createWorkbenchProjectProjection();
  let connectionCredential: string | undefined;

  const fetchResponse = async (method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> => {
    await ensureConnection();
    if (connectionEndedError) {
      throw connectionEndedError;
    }
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (connectionCredential) {
      headers['x-debrute-workbench-connection'] = connectionCredential;
    }
    const response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      throw await responseError(response);
    }
    return response;
  };
  const request = async <T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await fetchResponse(method, path, body, signal);
    if (response.status === 204) {
      return undefined as T;
    }
    return response.json() as Promise<T>;
  };
  const requestFormData = async <T>(
    method: string,
    path: string,
    body: FormData,
    signal?: AbortSignal
  ): Promise<T> => {
    await ensureConnection();
    if (connectionEndedError) {
      throw connectionEndedError;
    }
    const response = await fetch(path, {
      method,
      body,
      headers: {
        ...(connectionCredential ? { 'x-debrute-workbench-connection': connectionCredential } : {})
      },
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal })
    });
    if (!response.ok) {
      throw await responseError(response);
    }
    return response.json() as Promise<T>;
  };

  const projectRequestControllers = new Set<AbortController>();
  let connectionAbort: AbortController | undefined;
  let connectionReady: Promise<void> | undefined;
  let initialProjectError: DebruteHttpRequestError | undefined;
  let connectionEndedError: Error | undefined;
  let disposed = false;
  const boundProjectWaiters = new Map<string, Array<{
    resolve(project: WorkbenchProjectOpenResult): void;
    reject(error: Error): void;
  }>>();
  const eventListeners = new Set<(event: WorkbenchEvent) => void>();
  const pendingInitialEvents: WorkbenchEvent[] = [];
  let eventListenerWasRegistered = false;
  const connectionEndedListeners = new Set<(error: Error) => void>();
  const projectPathFor = (projectId: string, path: string) => `/api/projects/${encodeURIComponent(projectId)}${path}`;
  const currentProjectBinding = () => {
    const state = projectProjection.getState();
    return state.status === 'bound' ? state : undefined;
  };
  const projectPath = (path: string) => {
    const binding = currentProjectBinding();
    if (!binding) {
      throw new Error('Debrute project is not open.');
    }
    return projectPathFor(binding.projectId, path);
  };
  const captureProjectScope = (): ProjectRequestScope => {
    const binding = currentProjectBinding();
    if (!binding) {
      throw new Error('Debrute project is not open.');
    }
    return {
      projectId: binding.projectId,
      generation: binding.generation
    };
  };
  const isCurrentProjectScope = (scope: ProjectRequestScope): boolean => {
    const binding = currentProjectBinding();
    return binding?.projectId === scope.projectId && binding.generation === scope.generation;
  };
  const runProjectRequest = async <T>(
    operation: (scope: ProjectRequestScope, signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const scope = captureProjectScope();
    const controller = new AbortController();
    projectRequestControllers.add(controller);
    try {
      const result = await operation(scope, controller.signal);
      if (!isCurrentProjectScope(scope)) {
        throw new ProjectChangedRequestError('Project changed while the request was in flight.');
      }
      return result;
    } catch (error) {
      if (connectionEndedError) {
        throw connectionEndedError;
      }
      if (!isCurrentProjectScope(scope)) {
        throw new ProjectChangedRequestError('Project changed while the request was in flight.');
      }
      throw error;
    } finally {
      projectRequestControllers.delete(controller);
    }
  };
  const requestForCurrentProject = <T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> => runProjectRequest((scope, signal) => (
    request<T>(method, projectPathFor(scope.projectId, path), body, signal)
  ));
  const requestProjectMutation = <T extends RevisionedProjectCommandResult>(
    method: string,
    path: string,
    body?: object
  ): Promise<T> => runProjectRequest(async (scope, signal) => {
    const result = await request<T>(method, path, body, signal);
    if (result.projectId !== scope.projectId) {
      throw new Error(
        `Project command returned ${result.projectId} while bound to ${scope.projectId}.`
      );
    }
    await projectProjection.waitForRevision(scope.generation, result.projectRevision);
    return result;
  });
  const requestProjectFormDataMutation = <T extends RevisionedProjectCommandResult>(
    path: string,
    body: FormData
  ): Promise<T> => runProjectRequest(async (scope, signal) => {
    const result = await requestFormData<T>('POST', path, body, signal);
    if (result.projectId !== scope.projectId) {
      throw new Error(
        `Project command returned ${result.projectId} while bound to ${scope.projectId}.`
      );
    }
    await projectProjection.waitForRevision(scope.generation, result.projectRevision);
    return result;
  });
  const dispatchWorkbenchEvent = (event: WorkbenchEvent): void => {
    if ('projectId' in event && 'projectRevision' in event) {
      projectProjection.acceptProjectEvent(event);
    }
    if (eventListeners.size === 0 && !eventListenerWasRegistered) {
      pendingInitialEvents.push(event);
      return;
    }
    for (const listener of eventListeners) {
      listener(event);
    }
  };
  const markProjectDetached = (projectId: string): void => {
    projectProjection.detachProject(projectId);
    for (const controller of projectRequestControllers) {
      controller.abort();
    }
    projectRequestControllers.clear();
    terminalHub.unbindProject();
  };
  const commitCurrentProject = (project: WorkbenchProjectOpenResult): void => {
    if (!connectionCredential) {
      throw new Error('Runtime bound a Project before opening the Workbench connection.');
    }
    projectProjection.acceptBoundProject(project);
    for (const controller of projectRequestControllers) {
      controller.abort();
    }
    projectRequestControllers.clear();
    initialProjectError = undefined;
    terminalHub.bindProject(project.projectId, connectionCredential);
  };
  const acceptBoundProject = (project: WorkbenchProjectOpenResult): void => {
    for (const waiter of boundProjectWaiters.get(project.projectId) ?? []) {
      waiter.resolve(project);
    }
    boundProjectWaiters.delete(project.projectId);
  };
  const waitForBoundProject = (projectId: string): Promise<WorkbenchProjectOpenResult> => {
    const current = currentProjectBinding();
    if (current?.projectId === projectId) {
      return Promise.resolve({
        projectId: current.projectId,
        projectRevision: current.projectRevision,
        snapshot: current.authoritativeSnapshot,
        workingCopies: current.workingCopies
      });
    }
    if (connectionEndedError) {
      return Promise.reject(connectionEndedError);
    }
    return new Promise((resolve, reject) => {
      const waiters = boundProjectWaiters.get(projectId) ?? [];
      waiters.push({ resolve, reject });
      boundProjectWaiters.set(projectId, waiters);
    });
  };
  const ensureConnection = (): Promise<void> => {
    if (connectionReady) {
      return connectionReady;
    }
    const controller = new AbortController();
    connectionAbort = controller;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    let readySettled = false;
    const requestedProjectId = requestedProjectIdFromLocation();
    let globalSynchronized = false;
    let projectSynchronized = requestedProjectId === undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    connectionReady = ready;
    const settleReady = (): void => {
      if (!readySettled && globalSynchronized && projectSynchronized) {
        readySettled = true;
        resolveReady();
      }
    };
    void (async () => {
      try {
        const shell = getDebruteShellApi();
        const desktopLaunchTicket = shell ? await shell.takeDesktopLaunchTicket() : undefined;
        const response = await fetch('/api/workbench/connection', {
          method: 'POST',
          headers: {
            accept: 'text/event-stream',
            'content-type': 'application/json'
          },
          credentials: 'same-origin',
          signal: controller.signal,
          body: JSON.stringify({
            ...(requestedProjectId ? { requestedProjectId } : {}),
            ...(desktopLaunchTicket ? { desktopLaunchTicket } : {})
          })
        });
        if (!response.ok) {
          throw await responseError(response);
        }
        await readJsonSseStream(response, (value) => {
          if (isConnectionOpenedFrame(value)) {
            connectionCredential = value.connectionCredential;
            return;
          }
          if (isGlobalSnapshotFrame(value)) {
            globalSynchronized = true;
            dispatchWorkbenchEvent({ type: 'globalSettings.changed', settings: value.snapshot.settings });
            dispatchWorkbenchEvent({ type: 'adobeBridge.state.changed', state: value.snapshot.photoshop });
            dispatchWorkbenchEvent({ type: 'product.changed', product: value.snapshot.product });
            settleReady();
            return;
          }
          const projectConnectionFrame = decodeWorkbenchProjectConnectionFrame(value);
          if (projectConnectionFrame) {
            if (projectConnectionFrame.type === 'project.bound') {
              const project = {
                ...projectConnectionFrame.project,
                workingCopies: projectConnectionFrame.workingCopies
              };
              commitCurrentProject(project);
              acceptBoundProject(project);
              if (project.projectId === requestedProjectId) {
                projectSynchronized = true;
                settleReady();
              }
              return;
            }
            if (projectConnectionFrame.type === 'project.open_failed') {
              initialProjectError = new DebruteHttpRequestError(
                409,
                projectConnectionFrame.error.code,
                projectConnectionFrame.error.message,
                { projectId: projectConnectionFrame.projectId }
              );
              projectSynchronized = true;
              settleReady();
              return;
            }
            markProjectDetached(projectConnectionFrame.projectId);
            return;
          }
          if (isRecognizedWorkbenchProjectConnectionFrame(value)) {
            throw new Error(`Runtime sent an invalid ${value.type} Workbench connection frame.`);
          }
          if (isConnectionEndedFrame(value)) {
            throw new Error(`Runtime ended the Workbench connection: ${value.code}`);
          }
          if (isRecognizedConnectionFrame(value)) {
            throw new Error(`Runtime sent an invalid ${value.type} Workbench connection frame.`);
          }
          const workbenchEvent = decodeWorkbenchEvent(value);
          if (workbenchEvent) {
            dispatchWorkbenchEvent(workbenchEvent);
            return;
          }
          if (isRecognizedWorkbenchEventFrame(value)) {
            throw new Error(`Runtime sent an invalid ${value.type} Workbench event.`);
          }
        });
        if (!controller.signal.aborted && !disposed) {
          throw new Error('Runtime Workbench connection ended unexpectedly.');
        }
      } catch (error) {
        if (controller.signal.aborted || disposed) {
          return;
        }
        connectionEndedError = error instanceof Error ? error : new Error(String(error));
        projectProjection.endConnection(connectionEndedError);
        connectionCredential = undefined;
        terminalHub.unbindProject();
        for (const requestController of projectRequestControllers) {
          requestController.abort();
        }
        projectRequestControllers.clear();
        for (const waiters of boundProjectWaiters.values()) {
          for (const waiter of waiters) {
            waiter.reject(connectionEndedError);
          }
        }
        boundProjectWaiters.clear();
        if (!readySettled) {
          readySettled = true;
          rejectReady(connectionEndedError);
        }
        for (const listener of connectionEndedListeners) {
          listener(connectionEndedError);
        }
      }
    })();
    return ready;
  };

  return {
    projectProjection,
    adobeBridgeGetState: () => request<AdobeBridgeStateView>('GET', '/api/adobe-bridge'),
    adobeBridgeCreatePairing: () => request<{ pairingId: string; code: string; expiresAt: string }>(
      'POST',
      '/api/adobe-bridge/pairings'
    ),
    adobeBridgeCancelPairing: (pairingId) => request<void>(
      'DELETE',
      `/api/adobe-bridge/pairings/${encodeURIComponent(pairingId)}`
    ),
    adobeBridgeRemovePairing: (pluginInstanceId) => request<AdobeBridgeStateView>(
      'DELETE',
      `/api/adobe-bridge/plugin-instances/${encodeURIComponent(pluginInstanceId)}/pairing`
    ),
    adobeBridgeLinkPhotoshop: (input) => requestForCurrentProject<AdobeBridgeStateView>('POST', '/adobe-bridge/links', input),
    adobeBridgeUnlinkPhotoshop: (pluginInstanceId) => requestForCurrentProject<AdobeBridgeStateView>(
      'DELETE',
      `/adobe-bridge/links/${encodeURIComponent(pluginInstanceId)}`
    ),
    sendProjectFileToPhotoshop: (input) => requestForCurrentProject<SendProjectFileToPhotoshopResult>(
      'POST',
      '/adobe-bridge/send-to-photoshop',
      input
    ),
    openProject: async (input) => {
      await ensureConnection();
      const currentProjectId = currentProjectBinding()?.projectId;
      if ('projectId' in input) {
        if (initialProjectError && !input.forceOpenHere) {
          throw initialProjectError;
        }
        if (currentProjectId === input.projectId) {
          return waitForBoundProject(input.projectId);
        }
        if (!currentProjectId) {
          const opened = await request<ProjectBindingCommandResult>(
            'POST',
            '/api/projects/open',
            {
              projectId: input.projectId,
              ...(input.forceOpenHere ? { forceOpenHere: true } : {})
            }
          );
          if (opened.outcome === 'focused_existing_desktop') {
            return { outcome: opened.outcome, projectId: opened.projectId };
          }
          return waitForBoundProject(opened.projectId);
        }
        throw new Error(`Workbench is already bound to Project ${currentProjectId}.`);
      }
      if (!currentProjectId) {
        const opened = await request<ProjectBindingCommandResult>(
          'POST',
          '/api/projects/open',
          {
            projectRoot: input.projectRoot,
            ...(input.forceOpenHere ? { forceOpenHere: true } : {})
          }
        );
        if (opened.outcome === 'focused_existing_desktop') {
          return { outcome: opened.outcome, projectId: opened.projectId };
        }
        return waitForBoundProject(opened.projectId);
      }
      const opened = await request<ProjectBindingCommandResult>(
        'POST',
        '/api/projects/replace',
        {
          projectRoot: input.projectRoot,
          ...(input.forceOpenHere ? { forceOpenHere: true } : {})
        }
      );
      if (opened.outcome === 'focused_existing_desktop') {
        return { outcome: opened.outcome, projectId: opened.projectId };
      }
      return waitForBoundProject(opened.projectId);
    },
    openProjectFromPicker: async () => {
      await ensureConnection();
      const currentProjectId = currentProjectBinding()?.projectId;
      const result = await request<ProjectPickerCommandResult>('POST', '/api/projects/choose', {
        mode: currentProjectId ? 'replace' : 'open'
      });
      if (!result.opened) {
        return result;
      }
      if (result.outcome === 'focused_existing_desktop') {
        return {
          opened: true,
          outcome: 'focused_existing_desktop',
          projectId: result.projectId
        };
      }
      return { opened: true, ...await waitForBoundProject(result.projectId) };
    },
    clearRecentProjectRoots: () => request<{ ok: true }>('DELETE', '/api/workbench/recent-projects'),
    checkProductUpdate: () => request<{ ok: true }>('POST', '/api/runtime/product/update/check'),
    applyProductUpdate: () => request<{ ok: true }>('POST', '/api/runtime/product/update/apply'),
    globalSettingsSave: (input: SaveDebruteGlobalSettingsInput) => request<{ ok: true }>('PATCH', '/api/settings/global', input),
    revealModelApiKey: (modelId: string) => request('POST', '/api/settings/models/api-key/reveal', { modelId }),
    listTerminalSessions: () => requestForCurrentProject<TerminalSessionList>('GET', '/terminals'),
    createTerminalSession: (input) => requestForCurrentProject<TerminalSessionResult>('POST', '/terminals', input),
    writeTerminalInput: (input) => terminalHub.writeInput(input.terminalId, input.data),
    resizeTerminal: (input) => terminalHub.resize(input.terminalId, input.cols, input.rows),
    closeTerminalSession: (input) => requestForCurrentProject<{ ok: true }>(
      'DELETE',
      `/terminals/${encodeURIComponent(input.terminalId)}`
    ),
    subscribeTerminalEvents: (terminalId, listener, onError): TerminalEventSubscription => (
      terminalHub.subscribe(terminalId, listener, onError)
    ),
    readProjectTextFile: (projectRelativePath) => requestForCurrentProject<WorkbenchProjectTextFile>('GET', `/files/text/${encodeProjectPath(projectRelativePath)}`),
    writeProjectTextFile: (input: WriteProjectTextFileInput) => requestProjectMutation<WorkbenchProjectTextFileWriteResult>(
      'PUT',
      projectPath(`/files/text/${encodeProjectPath(input.projectRelativePath)}`),
      { content: input.content, expectedRevision: input.expectedRevision }
    ),
    putTextWorkingCopy: (projectId: string, input: WorkbenchTextWorkingCopy) => request<WorkbenchTextWorkingCopy>(
      'PUT',
      projectPathFor(projectId, `/working-copies/text/${encodeProjectPath(input.projectRelativePath)}`),
      {
        content: input.content,
        language: input.language,
        baseRevision: input.baseRevision
      }
    ),
    clearTextWorkingCopy: (projectId, projectRelativePath) => request<void>(
      'DELETE',
      projectPathFor(projectId, `/working-copies/text/${encodeProjectPath(projectRelativePath)}`)
    ),
    putFeedbackWorkingCopy: (projectId: string, input: WorkbenchFeedbackWorkingCopy) => request<WorkbenchFeedbackWorkingCopy>(
      'PUT',
      projectPathFor(projectId, `/working-copies/feedback/${encodeURIComponent(input.itemId)}`),
      input
    ),
    clearFeedbackWorkingCopy: (projectId, itemId) => request<void>(
      'DELETE',
      projectPathFor(projectId, `/working-copies/feedback/${encodeURIComponent(itemId)}`)
    ),
    saveCanvasTextPreviewSource: (input) => runProjectRequest((scope, signal) => (
      requestFormData<SaveCanvasTextPreviewSourceResult>(
        'POST',
        projectPathFor(scope.projectId, '/canvas-text-previews/source'),
        canvasTextPreviewSourceFormData(input),
        signal
      )
    )),
    readCanvasTextPreviewSources: (input) => runProjectRequest((scope, signal) => (
      request<CanvasTextPreviewSourceAvailabilityResponse>(
        'POST',
        projectPathFor(scope.projectId, '/canvas-text-previews/sources'),
        input,
        signal
      )
    )),
    readCanvasVideoPreviewSources: (input) => requestForCurrentProject<CanvasVideoPreviewSourceResponse>(
      'POST',
      '/canvas-video-previews/sources',
      input
    ),
    createProjectFile: (input) => requestProjectMutation<WorkbenchProjectFileOperationResult>('POST', projectPath('/files'), { ...input, kind: 'file' }),
    createProjectDirectory: (input) => requestProjectMutation<WorkbenchProjectFileOperationResult>('POST', projectPath('/files'), { ...input, kind: 'directory' }),
    renameProjectPath: (input) => requestProjectMutation<WorkbenchProjectFileOperationResult>('PATCH', projectPath(`/files/path/${encodeProjectPath(input.projectRelativePath)}`), {
      operation: 'rename',
      name: input.name
    }),
    copyProjectPaths: (input) => requestProjectMutation<WorkbenchProjectFileBatchOperationResult>('POST', projectPath('/files/batch/copy'), input),
    moveProjectPaths: (input) => requestProjectMutation<WorkbenchProjectFileBatchOperationResult>('POST', projectPath('/files/batch/move'), input),
    copyProjectAbsolutePaths: (input) => requestForCurrentProject<{ paths: string[] }>(
      'POST',
      '/files/path/batch/copy-path',
      input
    ),
    trashProjectPaths: (input) => requestProjectMutation<WorkbenchProjectFileBatchOperationResult>(
      'POST',
      projectPath('/files/path/batch/trash'),
      input
    ),
    deleteProjectPathsPermanently: (input) => requestProjectMutation<WorkbenchProjectFileBatchOperationResult>('POST', projectPath('/files/batch/delete-permanently'), input),
    importExternalLocalProjectPaths: (input) => requestProjectMutation<WorkbenchProjectFileBatchOperationResult>('POST', projectPath('/files/import/local'), input),
    importExternalProjectUploads: (input) => requestProjectFormDataMutation<WorkbenchProjectFileBatchOperationResult>(
      projectPath('/files/import/uploads'),
      uploadImportFormData(input)
    ),
    revealProjectPathInSystemFileManager: (input) => requestForCurrentProject<{ ok: true }>(
      'POST',
      `/files/path/${encodeProjectPath(input.projectRelativePath)}/reveal`,
      { kind: input.kind }
    ),
    lookupGeneratedAssetMetadata: (input) => requestForCurrentProject<GeneratedAssetMetadataLookup>('POST', '/generated-assets/lookup', input),
    readCanvasFeedback: () => requestForCurrentProject<CanvasFeedbackDocument>('GET', '/canvas-feedback'),
    updateCanvasFeedbackEntry: (input) => requestProjectMutation<WorkbenchCanvasFeedbackMutationResult>('PATCH', projectPath('/canvas-feedback'), input),
    createCanvas: () => requestProjectMutation<WorkbenchCanvasManagementResult>('POST', projectPath('/canvases')),
    renameCanvas: (input) => requestProjectMutation<WorkbenchCanvasManagementResult>(
      'PATCH',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}`),
      { operation: 'rename', name: input.name }
    ),
    deleteCanvas: (input) => requestProjectMutation<WorkbenchCanvasManagementResult>(
      'DELETE',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}`)
    ),
    reorderCanvases: (input) => requestProjectMutation<WorkbenchCanvasManagementResult>(
      'PUT',
      projectPath('/canvases/index'),
      input
    ),
    repairCanvasIndex: () => requestProjectMutation<WorkbenchCanvasManagementResult>('POST', projectPath('/canvases/index/repair')),
    addProjectPathToCanvasMap: (input: AddProjectPathToCanvasMapInput) => requestProjectMutation<WorkbenchAddProjectPathToCanvasMapResult>(
      'POST',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/canvas-map/project-paths`),
      { projectRelativePath: input.projectRelativePath }
    ),
    updateCanvasNodeLayouts: (input) => requestProjectMutation<WorkbenchCanvasDocumentMutationResult>('PATCH', projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/node-layouts`), {
      nodeLayouts: input.nodeLayouts
    }),
    resetCanvasNodeLayouts: (input) => requestProjectMutation<WorkbenchCanvasResetLayoutResult>(
      'POST',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/reset-layout`),
      'all' in input ? { all: true } : { pathRules: input.pathRules }
    ),
    bringCanvasNodeToFront: (input) => requestProjectMutation<WorkbenchCanvasDocumentMutationResult>('POST', projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/node-stack-order/bring-to-front`), {
      projectRelativePath: input.projectRelativePath
    }),
    updateCanvasVideoPlaybackState: (input: UpdateCanvasVideoPlaybackStateInput) => requestProjectMutation<WorkbenchCanvasDocumentMutationResult>(
      'PATCH',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/video-playback`),
      { updates: input.updates }
    ),
    updateCanvasTextViewportState: (input: UpdateCanvasTextViewportStateInput) => requestProjectMutation<WorkbenchCanvasDocumentMutationResult>(
      'PATCH',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/text-viewport`),
      { updates: input.updates }
    ),
    integrationsRescan: () => request<{ ok: true }>('POST', '/api/integrations/rescan', {}),
    integrationsRunOperation: (input: RunIntegrationOperationInput) => request<RunIntegrationOperationResult>(
      'POST',
      `/api/integrations/${encodeURIComponent(input.integrationId)}/${encodeURIComponent(input.operation)}`,
      {}
    ),
    onEvent: (listener: (event: WorkbenchEvent) => void) => {
      eventListeners.add(listener);
      if (!eventListenerWasRegistered) {
        eventListenerWasRegistered = true;
        for (const event of pendingInitialEvents.splice(0)) {
          listener(event);
        }
      }
      void ensureConnection().catch(() => undefined);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onConnectionEnded: (listener) => {
      connectionEndedListeners.add(listener);
      if (connectionEndedError) {
        listener(connectionEndedError);
      }
      return () => {
        connectionEndedListeners.delete(listener);
      };
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      connectionAbort?.abort();
      for (const controller of projectRequestControllers) {
        controller.abort();
      }
      projectRequestControllers.clear();
      pendingInitialEvents.length = 0;
      terminalHub.unbindProject();
      terminalHub.dispose();
      connectionCredential = undefined;
      const error = new Error('Workbench API client was disposed.');
      projectProjection.endConnection(error);
      for (const waiters of boundProjectWaiters.values()) {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
      }
      boundProjectWaiters.clear();
    }
  };
}

function isConnectionOpenedFrame(value: unknown): value is {
  type: 'connection.opened';
  connectionCredential: string;
} {
  return isObject(value)
    && value.type === 'connection.opened'
    && typeof value.connectionCredential === 'string';
}

function isRecognizedConnectionFrame(value: unknown): value is Record<string, unknown> & { type: string } {
  return isObject(value)
    && (
      value.type === 'connection.opened'
      || value.type === 'global.snapshot'
      || value.type === 'connection.ended'
    );
}

function isGlobalSnapshotFrame(value: unknown): value is GlobalSnapshotFrame {
  return isObject(value)
    && value.type === 'global.snapshot'
    && typeof value.globalRevision === 'number'
    && isObject(value.snapshot)
    && isObject(value.snapshot.settings);
}

function isConnectionEndedFrame(value: unknown): value is {
  type: 'connection.ended';
  code: string;
} {
  return isObject(value)
    && value.type === 'connection.ended'
    && typeof value.code === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestedProjectIdFromLocation(): string | undefined {
  const match = location.pathname.match(/^\/projects\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function encodeProjectPath(projectRelativePath: string): string {
  return projectRelativePath.split('/').map(encodeURIComponent).join('/');
}

function uploadImportFormData(input: WorkbenchProjectUploadImportInput): FormData {
  const formData = new FormData();
  const plan: RuntimeProjectUploadImportPlan = {
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
    return new DebruteHttpRequestError(response.status, undefined, `Debrute Runtime request failed: ${response.status}`, undefined);
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
