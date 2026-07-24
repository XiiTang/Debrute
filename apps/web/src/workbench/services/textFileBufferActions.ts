import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { WorkbenchApiClient, WorkbenchTextWorkingCopy } from '@debrute/app-protocol';
import type { FloatingTextEditorWindowState, TextFileBuffer } from '../../types';
import { textBufferFromFile } from './textFileBuffers';
import { clearTextBufferError } from './textEditorWindows';

export interface TextFileBufferActions {
  ensureTextFileBuffer(projectRelativePath: string): Promise<void>;
  updateTextFileBuffer(projectRelativePath: string, content: string): void;
  saveTextFileBuffer(projectRelativePath: string): Promise<void>;
  discardTextFileBuffer(projectRelativePath: string): Promise<void>;
  reloadTextFileBuffer(projectRelativePath: string): Promise<void>;
  refreshTextFileBuffer(projectRelativePath: string): Promise<void>;
}

interface TextFileSaveCoordinator {
  activeContentVersion: number;
  contentVersion: number;
  observedDiskRevision: string | undefined;
  queued: boolean;
  running: Promise<void>;
}

type TextWorkingCopyAction =
  | { kind: 'put'; value: WorkbenchTextWorkingCopy }
  | { kind: 'clear' };

interface TextWorkingCopyCoordinator {
  desired: TextWorkingCopyAction | undefined;
  running: Promise<boolean>;
}

export function useTextFileBufferActions(input: {
  api: WorkbenchApiClient;
  projectId: string | undefined;
  textFileBuffers: Record<string, TextFileBuffer>;
  setTextFileBuffers: Dispatch<SetStateAction<Record<string, TextFileBuffer>>>;
  textFileBuffersRef: MutableRefObject<Record<string, TextFileBuffer>>;
  textEditorWindowsRef: MutableRefObject<Record<string, FloatingTextEditorWindowState>>;
}): TextFileBufferActions {
  const { api, projectId, textFileBuffers, setTextFileBuffers, textFileBuffersRef, textEditorWindowsRef } = input;
  const projectIdRef = useRef(projectId);
  const saveCoordinatorsRef = useRef(new Map<string, TextFileSaveCoordinator>());
  const workingCopyCoordinatorsRef = useRef(new Map<string, TextWorkingCopyCoordinator>());
  projectIdRef.current = projectId;

  const enqueueWorkingCopy = useCallback((
    workingCopyProjectId: string,
    projectRelativePath: string,
    action: TextWorkingCopyAction
  ): Promise<boolean> => {
    const key = textFileSaveCoordinatorKey(workingCopyProjectId, projectRelativePath);
    const active = workingCopyCoordinatorsRef.current.get(key);
    if (active) {
      active.desired = action;
      return active.running;
    }
    const coordinator: TextWorkingCopyCoordinator = {
      desired: action,
      running: Promise.resolve(true)
    };
    workingCopyCoordinatorsRef.current.set(key, coordinator);
    coordinator.running = (async () => {
      let succeeded = true;
      while (coordinator.desired) {
        const next = coordinator.desired;
        coordinator.desired = undefined;
        try {
          if (next.kind === 'put') {
            await api.putTextWorkingCopy(workingCopyProjectId, next.value);
          } else {
            await api.clearTextWorkingCopy(workingCopyProjectId, projectRelativePath);
          }
        } catch (error) {
          succeeded = false;
          if (projectIdRef.current === workingCopyProjectId) {
            setTextFileBufferSaveError(setTextFileBuffers, projectRelativePath, error);
          }
        }
      }
      workingCopyCoordinatorsRef.current.delete(key);
      return succeeded;
    })();
    return coordinator.running;
  }, [api, setTextFileBuffers]);

  const ensureTextFileBuffer = useCallback(async (projectRelativePath: string) => {
    const ensureProjectId = projectIdRef.current;
    const current = textFileBuffers[projectRelativePath];
    if (current) {
      return;
    }
    try {
      const file = await api.readProjectTextFile(projectRelativePath);
      if (projectIdRef.current !== ensureProjectId) {
        return;
      }
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: {
          projectRelativePath: file.projectRelativePath,
          content: file.content,
          language: file.language,
          wordWrap: buffers[projectRelativePath]?.wordWrap ?? false,
          dirty: false,
          saving: false,
          baseRevision: file.revision,
          externalChange: false
        }
      }));
    } catch (error) {
      if (projectIdRef.current !== ensureProjectId) {
        return;
      }
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: textBufferErrorState(projectRelativePath, current, error)
      }));
    }
  }, [api, setTextFileBuffers, textFileBuffers]);

  const updateTextFileBuffer = useCallback((projectRelativePath: string, content: string) => {
    const currentProjectId = projectIdRef.current;
    const activeSave = currentProjectId
      ? saveCoordinatorsRef.current.get(textFileSaveCoordinatorKey(currentProjectId, projectRelativePath))
      : undefined;
    if (activeSave) {
      activeSave.contentVersion += 1;
    }
    const current = textFileBuffersRef.current[projectRelativePath];
    if (currentProjectId && current?.baseRevision) {
      void enqueueWorkingCopy(currentProjectId, projectRelativePath, {
        kind: 'put',
        value: {
          projectRelativePath,
          content,
          language: current.language,
          baseRevision: current.baseRevision
        }
      });
    }
    setTextFileBuffers((buffers) => {
      const current = buffers[projectRelativePath];
      return {
        ...buffers,
        [projectRelativePath]: {
          projectRelativePath,
          content,
          language: current?.language ?? 'plaintext',
          wordWrap: current?.wordWrap ?? false,
          dirty: true,
          saving: current?.saving ?? false,
          ...(current?.baseRevision ? { baseRevision: current.baseRevision } : {}),
          externalChange: current?.externalChange ?? false
        }
      };
    });
  }, [enqueueWorkingCopy, setTextFileBuffers, textFileBuffersRef]);

  const saveTextFileBuffer = useCallback((projectRelativePath: string): Promise<void> => {
    const saveProjectId = projectIdRef.current;
    if (!saveProjectId) {
      return Promise.resolve();
    }
    const coordinatorKey = textFileSaveCoordinatorKey(saveProjectId, projectRelativePath);
    const active = saveCoordinatorsRef.current.get(coordinatorKey);
    if (active) {
      if (active.contentVersion !== active.activeContentVersion) {
        active.queued = true;
      }
      return active.running;
    }

    const initial = textFileBuffersRef.current[projectRelativePath];
    if (!initial) {
      return Promise.resolve();
    }
    const coordinator: TextFileSaveCoordinator = {
      activeContentVersion: 0,
      contentVersion: 0,
      observedDiskRevision: undefined,
      queued: false,
      running: Promise.resolve()
    };
    saveCoordinatorsRef.current.set(coordinatorKey, coordinator);

    coordinator.running = (async () => {
      let committedRevision: string | undefined;
      try {
        while (true) {
          if (projectIdRef.current !== saveProjectId) {
            return;
          }
          coordinator.queued = false;
          coordinator.observedDiskRevision = undefined;
          const current = textFileBuffersRef.current[projectRelativePath] ?? initial;
          const savedContentVersion = coordinator.contentVersion;
          coordinator.activeContentVersion = savedContentVersion;
          const expectedRevision = committedRevision ?? current.baseRevision;

          setTextFileBuffers((buffers) => {
            const latest = buffers[projectRelativePath];
            return latest
              ? { ...buffers, [projectRelativePath]: clearTextBufferError({ ...latest, saving: true }) }
              : buffers;
          });

          if (!expectedRevision) {
            setTextFileBufferSaveError(
              setTextFileBuffers,
              projectRelativePath,
              new Error(`Project text file base revision is required: ${projectRelativePath}`)
            );
            return;
          }

          let saved: Awaited<ReturnType<WorkbenchApiClient['writeProjectTextFile']>>['file'];
          try {
            saved = (await api.writeProjectTextFile({
              projectRelativePath,
              content: current.content,
              expectedRevision
            })).file;
          } catch (error) {
            if (projectIdRef.current !== saveProjectId) {
              return;
            }
            const externalChangeObserved = coordinator.observedDiskRevision !== undefined
              && coordinator.observedDiskRevision !== expectedRevision;
            const continueSaving = coordinator.queued
              && coordinator.contentVersion !== savedContentVersion
              && !externalChangeObserved;
            setTextFileBufferSaveError(setTextFileBuffers, projectRelativePath, error, continueSaving);
            if (continueSaving) {
              continue;
            }
            return;
          }

          if (projectIdRef.current !== saveProjectId) {
            return;
          }

          committedRevision = saved.revision;
          const contentChanged = coordinator.contentVersion !== savedContentVersion;
          const externalChangeObserved = coordinator.observedDiskRevision !== undefined
            && coordinator.observedDiskRevision !== expectedRevision
            && coordinator.observedDiskRevision !== saved.revision;
          const continueSaving = coordinator.queued && contentChanged && !externalChangeObserved;
          if (!contentChanged && !externalChangeObserved) {
            const cleared = await enqueueWorkingCopy(
              saveProjectId,
              projectRelativePath,
              { kind: 'clear' }
            );
            if (!cleared) {
              setTextFileBuffers((buffers) => {
                const latest = buffers[projectRelativePath];
                return latest
                  ? {
                      ...buffers,
                      [projectRelativePath]: {
                        ...latest,
                        dirty: true,
                        saving: false,
                        baseRevision: saved.revision,
                        externalChange: false
                      }
                    }
                  : buffers;
              });
              return;
            }
          }
          setTextFileBuffers((buffers) => {
            const latest = buffers[projectRelativePath];
            if (!latest) {
              return buffers;
            }
            if (contentChanged || externalChangeObserved) {
              return {
                ...buffers,
                [projectRelativePath]: clearTextBufferError({
                  ...latest,
                  dirty: true,
                  saving: continueSaving,
                  ...(externalChangeObserved ? {} : { baseRevision: saved.revision }),
                  externalChange: externalChangeObserved
                })
              };
            }
            return {
              ...buffers,
              [projectRelativePath]: {
                projectRelativePath: saved.projectRelativePath,
                content: saved.content,
                language: saved.language,
                wordWrap: latest.wordWrap,
                dirty: false,
                saving: false,
                baseRevision: saved.revision,
                externalChange: false
              }
            };
          });
          if (!continueSaving) {
            return;
          }
        }
      } finally {
        saveCoordinatorsRef.current.delete(coordinatorKey);
      }
    })();
    return coordinator.running;
  }, [api, enqueueWorkingCopy, setTextFileBuffers, textFileBuffersRef]);

  const reloadTextFileBuffer = useCallback(async (projectRelativePath: string) => {
    const reloadProjectId = projectIdRef.current;
    if (!reloadProjectId) {
      return;
    }
    await saveCoordinatorsRef.current.get(
      textFileSaveCoordinatorKey(reloadProjectId, projectRelativePath)
    )?.running;
    if (projectIdRef.current !== reloadProjectId) {
      return;
    }
    try {
      const file = await api.readProjectTextFile(projectRelativePath);
      if (projectIdRef.current !== reloadProjectId) {
        return;
      }
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: {
          projectRelativePath: file.projectRelativePath,
          content: file.content,
          language: file.language,
          wordWrap: buffers[projectRelativePath]?.wordWrap ?? false,
          dirty: false,
          saving: false,
          baseRevision: file.revision,
          externalChange: false
        }
      }));
    } catch (error) {
      if (projectIdRef.current !== reloadProjectId) {
        return;
      }
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: textBufferErrorState(projectRelativePath, buffers[projectRelativePath], error)
      }));
    }
  }, [api, setTextFileBuffers]);

  const discardTextFileBuffer = useCallback(async (projectRelativePath: string) => {
    const discardProjectId = projectIdRef.current;
    if (discardProjectId) {
      const cleared = await enqueueWorkingCopy(
        discardProjectId,
        projectRelativePath,
        { kind: 'clear' }
      );
      if (!cleared) {
        return;
      }
    }
    await reloadTextFileBuffer(projectRelativePath);
  }, [enqueueWorkingCopy, reloadTextFileBuffer]);

  const refreshTextFileBuffer = useCallback(async (projectRelativePath: string) => {
    const refreshProjectId = projectIdRef.current;
    const current = textFileBuffersRef.current[projectRelativePath];
    const windowState = textEditorWindowsRef.current[projectRelativePath];
    if (!current && !windowState?.open) {
      return;
    }
    try {
      const file = await api.readProjectTextFile(projectRelativePath);
      if (projectIdRef.current !== refreshProjectId) {
        return;
      }
      if (refreshProjectId) {
        const activeSave = saveCoordinatorsRef.current.get(
          textFileSaveCoordinatorKey(refreshProjectId, projectRelativePath)
        );
        if (activeSave) {
          activeSave.observedDiskRevision = file.revision;
        }
      }
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: textBufferFromFile(file, buffers[projectRelativePath])
      }));
    } catch (error) {
      if (projectIdRef.current !== refreshProjectId) {
        return;
      }
      setTextFileBuffers((buffers) => {
        const currentBuffer = buffers[projectRelativePath];
        if (!currentBuffer && !windowState?.open) {
          return buffers;
        }
        return {
          ...buffers,
          [projectRelativePath]: textBufferErrorState(projectRelativePath, currentBuffer ?? current, error)
        };
      });
    }
  }, [api, setTextFileBuffers, textEditorWindowsRef, textFileBuffersRef]);

  return {
    ensureTextFileBuffer,
    updateTextFileBuffer,
    saveTextFileBuffer,
    discardTextFileBuffer,
    reloadTextFileBuffer,
    refreshTextFileBuffer
  };
}

function textFileSaveCoordinatorKey(projectId: string, projectRelativePath: string): string {
  return `${projectId}\u0000${projectRelativePath}`;
}

function textBufferErrorState(projectRelativePath: string, current: TextFileBuffer | undefined, error: unknown): TextFileBuffer {
  return {
    projectRelativePath,
    content: current?.content ?? '',
    language: current?.language ?? 'plaintext',
    wordWrap: current?.wordWrap ?? false,
    dirty: current?.dirty ?? false,
    saving: false,
    ...(current?.baseRevision ? { baseRevision: current.baseRevision } : {}),
    externalChange: current?.externalChange ?? false,
    error: errorMessage(error)
  };
}

function setTextFileBufferSaveError(
  setTextFileBuffers: Dispatch<SetStateAction<Record<string, TextFileBuffer>>>,
  projectRelativePath: string,
  error: unknown,
  saving = false
): void {
  setTextFileBuffers((buffers) => {
    const current = buffers[projectRelativePath];
    return current
      ? {
          ...buffers,
          [projectRelativePath]: {
            ...current,
            saving,
            dirty: true,
            error: errorMessage(error)
          }
        }
      : buffers;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
