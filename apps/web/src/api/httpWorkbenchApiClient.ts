import type {
  WorkbenchActivityNoticeInput,
  AddProjectPathToCanvasMapInput,
  CanvasTextPreviewSourceAvailabilityResponse,
  CanvasVideoPreviewEnsureResponse,
  CanvasVideoPreviewProbeResponse,
  DebruteGlobalSettingsView,
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
  WorkbenchProjectTarget,
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
  decodeWorkbenchActivityFrame,
  decodeWorkbenchEvent,
  decodeWorkbenchProjectConnectionFrame,
  isRecognizedWorkbenchActivityFrame,
  isRecognizedWorkbenchEventFrame,
  isRecognizedWorkbenchProjectConnectionFrame
} from '@debrute/app-protocol';
import type { CanvasFeedbackDocument } from '@debrute/canvas-core';
import { readJsonSseStream } from './streamingSse.js';
import type { TerminalHubClient } from './terminalHubClient.js';
import { getDebruteShellApi } from './shellApi.js';
import {
  createWorkbenchActivities,
  type WorkbenchActivities
} from '../workbench/services/WorkbenchActivities.js';
import {
  createWorkbenchGlobalProjection,
  type WorkbenchGlobalEvent,
  type WorkbenchGlobalProjection
} from '../workbench/services/WorkbenchGlobalProjection.js';
import {
  createWorkbenchProjectProjection,
  type WorkbenchProjectProjection
} from '../workbench/services/WorkbenchProjectProjection.js';
import {
  workbenchStartupTimeline,
  type WorkbenchStartupTimeline
} from '../startup/workbenchStartupTimeline.js';

interface ProjectRequestScope {
  projectId: string;
  generation: number;
}

interface RevisionedProjectCommandResult {
  projectId: string;
  projectRevision: number;
}

export interface HttpWorkbenchApiClient extends WorkbenchApiClient {
  readonly activities: WorkbenchActivities;
  readonly globalProjection: WorkbenchGlobalProjection;
  readonly projectProjection: WorkbenchProjectProjection;
  bootstrapGlobalSettings(): Promise<WorkbenchGlobalSettingsBootstrap>;
}

export interface WorkbenchGlobalSettingsBootstrap {
  globalRevision: number;
  settings: DebruteGlobalSettingsView;
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
  };
}

interface ProjectBindingCommandResult {
  projectId: string;
  outcome: 'bound' | 'focused_existing_desktop';
}

type ProjectPickerCommandResult =
  | { selected: false }
  | { selected: true; projectRoot: string };

export function createHttpWorkbenchApiClient(options: {
  startupTimeline?: Pick<WorkbenchStartupTimeline, 'mark'>;
} = {}): HttpWorkbenchApiClient {
  const startupTimeline = options.startupTimeline ?? workbenchStartupTimeline;
  const globalProjection = createWorkbenchGlobalProjection();
  const projectProjection = createWorkbenchProjectProjection();
  let terminalHub: TerminalHubClient | undefined;
  let terminalHubLoad: Promise<TerminalHubClient> | undefined;
  let terminalBinding: { projectId: string; connectionCredential: string } | undefined;
  let connectionCredential: string | undefined;
  let globalSettingsBootstrap: WorkbenchGlobalSettingsBootstrap | undefined;
  let globalSettingsBootstrapError: Error | undefined;
  let projectRootSelection: Promise<string | undefined> | undefined;
  const globalSettingsBootstrapWaiters: Array<{
    resolve(value: WorkbenchGlobalSettingsBootstrap): void;
    reject(error: Error): void;
  }> = [];

  const settleGlobalSettingsBootstrap = (value: WorkbenchGlobalSettingsBootstrap): void => {
    globalSettingsBootstrap = value;
    for (const waiter of globalSettingsBootstrapWaiters.splice(0)) {
      waiter.resolve(value);
    }
  };

  const rejectGlobalSettingsBootstrap = (error: Error): void => {
    globalSettingsBootstrapError = error;
    for (const waiter of globalSettingsBootstrapWaiters.splice(0)) {
      waiter.reject(error);
    }
  };

  const bootstrapGlobalSettings = (): Promise<WorkbenchGlobalSettingsBootstrap> => {
    if (globalSettingsBootstrap) {
      return Promise.resolve(globalSettingsBootstrap);
    }
    if (globalSettingsBootstrapError) {
      return Promise.reject(globalSettingsBootstrapError);
    }
    void ensureConnection().catch(() => undefined);
    return new Promise((resolve, reject) => {
      globalSettingsBootstrapWaiters.push({ resolve, reject });
    });
  };

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
  const activities = createWorkbenchActivities({
    dismiss: (id) => request<{ ok: true }>(
      'DELETE',
      `/api/activities/${encodeURIComponent(id)}`
    ),
    clearTerminal: () => request<{ ok: true; cleared: number }>('DELETE', '/api/activities')
  });

  const projectRequestControllers = new Set<AbortController>();
  let connectionAbort: AbortController | undefined;
  let connectionReady: Promise<void> | undefined;
  let initialProjectError: DebruteHttpRequestError | undefined;
  let connectionEndedError: Error | undefined;
  let disposed = false;
  const loadTerminalHub = (): Promise<TerminalHubClient> => {
    if (terminalHub) {
      return Promise.resolve(terminalHub);
    }
    terminalHubLoad ??= import('./terminalHubClient.js').then(({ createTerminalHubClient }) => {
      const hub = createTerminalHubClient();
      if (disposed) {
        hub.dispose();
        throw new Error('Workbench API client was disposed.');
      }
      terminalHub = hub;
      if (terminalBinding) {
        hub.bindProject(terminalBinding.projectId, terminalBinding.connectionCredential);
      }
      return hub;
    });
    return terminalHubLoad;
  };
  const deferTerminalHubSubscription = (
    subscribe: (hub: TerminalHubClient) => TerminalEventSubscription,
    onError: (error: Error) => void
  ): TerminalEventSubscription => {
    let closed = false;
    let subscription: TerminalEventSubscription | undefined;
    void loadTerminalHub().then((hub) => {
      if (!closed) {
        subscription = subscribe(hub);
      }
    }).catch((error: unknown) => {
      if (!closed) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      close() {
        closed = true;
        subscription?.close();
      }
    };
  };
  const bindTerminalProject = (projectId: string, connectionCredential: string): void => {
    terminalBinding = { projectId, connectionCredential };
    terminalHub?.bindProject(projectId, connectionCredential);
  };
  const unbindTerminalProject = (): void => {
    terminalBinding = undefined;
    terminalHub?.unbindProject();
  };
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
    operation: (scope: ProjectRequestScope, signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal
  ): Promise<T> => {
    const scope = captureProjectScope();
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) {
      abortFromCaller();
    } else {
      callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    }
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
      callerSignal?.removeEventListener('abort', abortFromCaller);
      projectRequestControllers.delete(controller);
    }
  };
  const requestForCurrentProject = <T>(
    method: string,
    path: string,
    body?: unknown,
    callerSignal?: AbortSignal
  ): Promise<T> => runProjectRequest((scope, signal) => (
    request<T>(method, projectPathFor(scope.projectId, path), body, signal)
  ), callerSignal);
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
    } else {
      globalProjection.acceptEvent(event as WorkbenchGlobalEvent);
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
    unbindTerminalProject();
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
    bindTerminalProject(project.projectId, connectionCredential);
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
  const requestProjectBinding = async (
    path: '/api/projects/open' | '/api/projects/replace',
    target: WorkbenchProjectTarget
  ): ReturnType<WorkbenchApiClient['openProject']> => {
    startupTimeline.mark('project-open-requested');
    const opened = await request<ProjectBindingCommandResult>('POST', path, target);
    if (opened.outcome === 'focused_existing_desktop') {
      return { outcome: opened.outcome, projectId: opened.projectId };
    }
    return waitForBoundProject(opened.projectId);
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
    let activitySynchronized = false;
    let projectSynchronized = requestedProjectId === undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    connectionReady = ready;
    const settleReady = (): void => {
      if (!readySettled && globalSynchronized && activitySynchronized && projectSynchronized) {
        readySettled = true;
        resolveReady();
      }
    };
    void (async () => {
      try {
        const shell = getDebruteShellApi();
        const desktopLaunchTicket = shell ? await shell.takeDesktopLaunchTicket() : undefined;
        if (requestedProjectId) {
          startupTimeline.mark('project-open-requested');
        }
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
            globalProjection.acceptSnapshot({
              revision: value.globalRevision,
              settings: value.snapshot.settings
            });
            settleGlobalSettingsBootstrap({
              globalRevision: value.globalRevision,
              settings: value.snapshot.settings
            });
            settleReady();
            return;
          }
          const activityFrame = decodeWorkbenchActivityFrame(value);
          if (activityFrame) {
            activities.acceptFrame(activityFrame);
            if (activityFrame.type === 'activity.snapshot') {
              activitySynchronized = true;
              settleReady();
            }
            return;
          }
          if (isRecognizedWorkbenchActivityFrame(value)) {
            throw new Error(`Runtime sent an invalid ${value.type} Activity frame.`);
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
        rejectGlobalSettingsBootstrap(connectionEndedError);
        globalProjection.endConnection(connectionEndedError);
        projectProjection.endConnection(connectionEndedError);
        connectionCredential = undefined;
        unbindTerminalProject();
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
    activities,
    globalProjection,
    projectProjection,
    bootstrapGlobalSettings,
    reportActivityNotice: (input) => isProjectScopedActivityNotice(input)
      ? requestForCurrentProject<{ activityId: string }>('POST', '/activities/notices', input)
      : request<{ activityId: string }>('POST', '/api/activities/notices', input),
    dismissActivity: (activityId) => request<{ ok: true }>(
      'DELETE',
      `/api/activities/${encodeURIComponent(activityId)}`
    ),
    clearTerminalActivities: () => request<{ ok: true; cleared: number }>(
      'DELETE',
      '/api/activities'
    ),
    sendProjectFileToPhotoshop: (input) => requestForCurrentProject<SendProjectFileToPhotoshopResult>(
      'POST',
      '/photoshop/send',
      input
    ),
    openProject: async (target) => {
      await ensureConnection();
      const currentProjectId = currentProjectBinding()?.projectId;
      if ('projectId' in target) {
        if (initialProjectError) {
          throw initialProjectError;
        }
        if (currentProjectId === target.projectId) {
          return waitForBoundProject(target.projectId);
        }
        if (!currentProjectId) {
          return requestProjectBinding('/api/projects/open', target);
        }
        throw new Error(`Workbench is already bound to Project ${currentProjectId}.`);
      }
      if (!currentProjectId) {
        return requestProjectBinding('/api/projects/open', target);
      }
      return requestProjectBinding('/api/projects/replace', target);
    },
    chooseProjectRoot: () => {
      if (projectRootSelection) {
        return projectRootSelection;
      }
      const selection = request<ProjectPickerCommandResult>('POST', '/api/projects/choose', {})
        .then((result) => result.selected ? result.projectRoot : undefined);
      const sharedSelection = selection.finally(() => {
        if (projectRootSelection === sharedSelection) {
          projectRootSelection = undefined;
        }
      });
      projectRootSelection = sharedSelection;
      return sharedSelection;
    },
    clearRecentProjectRoots: () => request<{ ok: true }>('DELETE', '/api/workbench/recent-projects'),
    checkProductUpdate: () => request<{ ok: true }>('POST', '/api/runtime/product/update/check'),
    applyProductUpdate: () => request<{ ok: true }>('POST', '/api/runtime/product/update/apply'),
    globalSettingsSave: (input: SaveDebruteGlobalSettingsInput) => request<{ ok: true }>('PATCH', '/api/settings/global', input),
    revealModelApiKey: (modelId: string) => request('POST', '/api/settings/models/api-key/reveal', { modelId }),
    subscribeTerminalSessions: (listener, onError) => deferTerminalHubSubscription(
      (hub) => hub.subscribeSessions(listener, onError),
      onError
    ),
    createTerminalSession: (input) => requestForCurrentProject<TerminalSessionResult>('POST', '/terminals', input),
    writeTerminalInput: async (input) => (
      (await loadTerminalHub()).writeInput(input.terminalId, input.data)
    ),
    resizeTerminal: async (input) => (
      (await loadTerminalHub()).resize(input.terminalId, input.cols, input.rows)
    ),
    closeTerminalSession: (input) => requestForCurrentProject<{ ok: true }>(
      'DELETE',
      `/terminals/${encodeURIComponent(input.terminalId)}`
    ),
    subscribeTerminalEvents: (terminalId, listener, onError) => deferTerminalHubSubscription(
      (hub) => hub.subscribe(terminalId, listener, onError),
      onError
    ),
    readProjectTextFile: (projectRelativePath) => requestForCurrentProject<WorkbenchProjectTextFile>('GET', `/files/text/${encodeProjectPath(projectRelativePath)}`),
    loadProjectDirectory: (projectRelativeDirectory) => requestProjectMutation(
      'POST',
      projectPath('/files/load-directory'),
      { projectRelativeDirectory }
    ),
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
    probeCanvasVideoPreviewSources: (input, signal) => requestForCurrentProject<CanvasVideoPreviewProbeResponse>(
      'POST',
      '/canvas-video-previews/probe',
      input,
      signal
    ),
    ensureCanvasVideoPreviewSource: (input, signal) => requestForCurrentProject<CanvasVideoPreviewEnsureResponse>(
      'POST',
      '/canvas-video-previews/ensure',
      input,
      signal
    ),
    createProjectFile: (input) => requestProjectMutation<WorkbenchProjectFileOperationResult>('POST', projectPath('/files'), { ...input, kind: 'file' }),
    createProjectDirectory: (input) => requestProjectMutation<WorkbenchProjectFileOperationResult>('POST', projectPath('/files'), { ...input, kind: 'directory' }),
    renameProjectPath: (input) => requestProjectMutation<WorkbenchProjectFileOperationResult>('PATCH', projectPath(`/files/path/${encodeProjectPath(input.projectRelativePath)}`), {
      operation: 'rename',
      name: input.name
    }),
    copyProjectPaths: (input) => requestProjectMutation<WorkbenchProjectFileBatchOperationResult>('POST', projectPath('/files/batch/copy'), input),
    moveProjectPaths: (input) => requestProjectMutation<WorkbenchProjectFileBatchOperationResult>('POST', projectPath('/files/batch/move'), input),
    copyProjectPathsToSystemClipboard: (input) => requestForCurrentProject<{ ok: true }>(
      'POST',
      '/files/path/batch/copy-to-system-clipboard',
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
    updateCanvasFeedback: (input) => requestProjectMutation<WorkbenchCanvasFeedbackMutationResult>('PATCH', projectPath('/canvas-feedback'), input),
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
      interaction: input.interaction,
      nodeLayouts: input.nodeLayouts
    }),
    resetCanvasNodeLayouts: (input) => requestProjectMutation<WorkbenchCanvasResetLayoutResult>(
      'POST',
      projectPath(`/canvases/${encodeURIComponent(input.canvasId)}/reset-layout`),
      'all' in input ? { all: true } : { nodePaths: input.nodePaths }
    ),
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
      unbindTerminalProject();
      terminalHub?.dispose();
      activities.dispose();
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

function isProjectScopedActivityNotice(input: WorkbenchActivityNoticeInput): boolean {
  return input.kind === 'project-opened'
    || input.kind === 'project-view-state-reset'
    || input.kind === 'project-operation-failed'
    || input.kind === 'canvas-operation-failed'
    || input.kind === 'explorer-operation-failed';
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
    && Number.isSafeInteger(value.globalRevision)
    && (value.globalRevision as number) >= 0
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
