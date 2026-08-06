import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { WorkbenchApiClient, WorkbenchTextWorkingCopy } from '@debrute/app-protocol';
import type { FloatingTextEditorWindowState, TextFileBuffer } from '../../types';
import { textBufferFromFile } from './textFileBuffers';
import { clearTextBufferError } from './textEditorWindows';

type TextFileBufferApi = Pick<WorkbenchApiClient,
  | 'putTextWorkingCopy'
  | 'clearTextWorkingCopy'
  | 'readProjectTextFile'
  | 'writeProjectTextFile'
>;

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
  api: TextFileBufferApi;
  bindingId: string | undefined;
  textFileBuffers: Record<string, TextFileBuffer>;
  setTextFileBuffers: Dispatch<SetStateAction<Record<string, TextFileBuffer>>>;
  textFileBuffersRef: MutableRefObject<Record<string, TextFileBuffer>>;
  textEditorWindowsRef: MutableRefObject<Record<string, FloatingTextEditorWindowState>>;
}): TextFileBufferActions {
  const { api, bindingId, textFileBuffers, setTextFileBuffers, textFileBuffersRef, textEditorWindowsRef } = input;
  const bindingIdRef = useRef(bindingId);
  const saveCoordinatorsRef = useRef(new Map<string, TextFileSaveCoordinator>());
  const workingCopyCoordinatorsRef = useRef(new Map<string, TextWorkingCopyCoordinator>());
  bindingIdRef.current = bindingId;

  const enqueueWorkingCopy = useCallback((
    workingCopyBindingId: string,
    projectRelativePath: string,
    action: TextWorkingCopyAction
  ): Promise<boolean> => {
    const key = textFileSaveCoordinatorKey(workingCopyBindingId, projectRelativePath);
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
            await api.putTextWorkingCopy(workingCopyBindingId, next.value);
          } else {
            await api.clearTextWorkingCopy(workingCopyBindingId, projectRelativePath);
          }
        } catch (error) {
          succeeded = false;
          if (bindingIdRef.current === workingCopyBindingId) {
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
    const ensureBindingId = bindingIdRef.current;
    const current = textFileBuffers[projectRelativePath];
    if (current) {
      return;
    }
    try {
      const file = await api.readProjectTextFile(projectRelativePath);
      if (bindingIdRef.current !== ensureBindingId) {
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
      if (bindingIdRef.current !== ensureBindingId) {
        return;
      }
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: textBufferErrorState(projectRelativePath, current, error)
      }));
    }
  }, [api, setTextFileBuffers, textFileBuffers]);

  const updateTextFileBuffer = useCallback((projectRelativePath: string, content: string) => {
    const currentBindingId = bindingIdRef.current;
    const activeSave = currentBindingId
      ? saveCoordinatorsRef.current.get(textFileSaveCoordinatorKey(currentBindingId, projectRelativePath))
      : undefined;
    if (activeSave) {
      activeSave.contentVersion += 1;
    }
    const current = textFileBuffersRef.current[projectRelativePath];
    if (currentBindingId && current?.baseRevision) {
      void enqueueWorkingCopy(currentBindingId, projectRelativePath, {
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
    const saveBindingId = bindingIdRef.current;
    if (!saveBindingId) {
      return Promise.resolve();
    }
    const coordinatorKey = textFileSaveCoordinatorKey(saveBindingId, projectRelativePath);
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
          if (bindingIdRef.current !== saveBindingId) {
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
            if (bindingIdRef.current !== saveBindingId) {
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

          if (bindingIdRef.current !== saveBindingId) {
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
              saveBindingId,
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
    const reloadBindingId = bindingIdRef.current;
    if (!reloadBindingId) {
      return;
    }
    await saveCoordinatorsRef.current.get(
      textFileSaveCoordinatorKey(reloadBindingId, projectRelativePath)
    )?.running;
    if (bindingIdRef.current !== reloadBindingId) {
      return;
    }
    try {
      const file = await api.readProjectTextFile(projectRelativePath);
      if (bindingIdRef.current !== reloadBindingId) {
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
      if (bindingIdRef.current !== reloadBindingId) {
        return;
      }
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: textBufferErrorState(projectRelativePath, buffers[projectRelativePath], error)
      }));
    }
  }, [api, setTextFileBuffers]);

  const discardTextFileBuffer = useCallback(async (projectRelativePath: string) => {
    const discardBindingId = bindingIdRef.current;
    if (discardBindingId) {
      const cleared = await enqueueWorkingCopy(
        discardBindingId,
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
    const refreshBindingId = bindingIdRef.current;
    const current = textFileBuffersRef.current[projectRelativePath];
    const windowState = textEditorWindowsRef.current[projectRelativePath];
    if (!current && !windowState?.open) {
      return;
    }
    try {
      const file = await api.readProjectTextFile(projectRelativePath);
      if (bindingIdRef.current !== refreshBindingId) {
        return;
      }
      if (refreshBindingId) {
        const activeSave = saveCoordinatorsRef.current.get(
          textFileSaveCoordinatorKey(refreshBindingId, projectRelativePath)
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
      if (bindingIdRef.current !== refreshBindingId) {
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

function textFileSaveCoordinatorKey(bindingId: string, projectRelativePath: string): string {
  return `${bindingId}\u0000${projectRelativePath}`;
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
