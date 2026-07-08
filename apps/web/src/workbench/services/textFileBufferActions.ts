import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { WorkbenchApiClient } from '@debrute/app-protocol';
import type { FloatingTextEditorWindowState, TextFileBuffer } from '../../types';
import { textBufferFromFile } from './textFileBuffers';
import { clearTextBufferError } from './textEditorWindows';

export interface TextFileBufferActions {
  ensureTextFileBuffer(projectRelativePath: string, diskRevision?: string): Promise<void>;
  updateTextFileBuffer(projectRelativePath: string, content: string): void;
  saveTextFileBuffer(projectRelativePath: string): Promise<void>;
  discardTextFileBuffer(projectRelativePath: string): Promise<void>;
  reloadTextFileBuffer(projectRelativePath: string): Promise<void>;
  refreshTextFileBuffer(projectRelativePath: string): Promise<void>;
}

export function useTextFileBufferActions(input: {
  api: WorkbenchApiClient;
  textFileBuffers: Record<string, TextFileBuffer>;
  setTextFileBuffers: Dispatch<SetStateAction<Record<string, TextFileBuffer>>>;
  textFileBuffersRef: MutableRefObject<Record<string, TextFileBuffer>>;
  textEditorWindowsRef: MutableRefObject<Record<string, FloatingTextEditorWindowState>>;
}): TextFileBufferActions {
  const { api, textFileBuffers, setTextFileBuffers, textFileBuffersRef, textEditorWindowsRef } = input;

  const ensureTextFileBuffer = useCallback(async (projectRelativePath: string, diskRevision?: string) => {
    const current = textFileBuffers[projectRelativePath];
    if (current && (!diskRevision || current.diskRevision === diskRevision)) {
      return;
    }
    if (current?.dirty && diskRevision && current.diskRevision !== diskRevision) {
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: {
          ...buffers[projectRelativePath]!,
          diskRevision,
          externalChange: true
        }
      }));
      return;
    }
    try {
      const file = await api.readProjectTextFile(projectRelativePath);
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: {
          projectRelativePath: file.projectRelativePath,
          content: file.content,
          language: file.language,
          wordWrap: buffers[projectRelativePath]?.wordWrap ?? current?.wordWrap ?? false,
          dirty: false,
          saving: false,
          diskRevision: file.revision,
          lastSavedRevision: file.revision,
          externalChange: false
        }
      }));
    } catch (error) {
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: textBufferErrorState(projectRelativePath, current, error)
      }));
    }
  }, [api, setTextFileBuffers, textFileBuffers]);

  const updateTextFileBuffer = useCallback((projectRelativePath: string, content: string) => {
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
          saving: false,
          ...(current?.diskRevision ? { diskRevision: current.diskRevision } : {}),
          ...(current?.lastSavedRevision ? { lastSavedRevision: current.lastSavedRevision } : {}),
          externalChange: current?.externalChange ?? false
        }
      };
    });
  }, [setTextFileBuffers]);

  const saveTextFileBuffer = useCallback(async (projectRelativePath: string) => {
    const current = textFileBuffers[projectRelativePath];
    if (!current || current.saving) {
      return;
    }
    setTextFileBuffers((buffers) => ({
      ...buffers,
      [projectRelativePath]: clearTextBufferError({ ...current, saving: true })
    }));
    try {
      const saved = (await api.writeProjectTextFile(projectRelativePath, current.content)).file;
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: {
          projectRelativePath: saved.projectRelativePath,
          content: saved.content,
          language: saved.language,
          wordWrap: buffers[projectRelativePath]?.wordWrap ?? current.wordWrap,
          dirty: false,
          saving: false,
          diskRevision: saved.revision,
          lastSavedRevision: saved.revision,
          externalChange: false
        }
      }));
    } catch (error) {
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: {
          ...buffers[projectRelativePath]!,
          saving: false,
          dirty: true,
          error: errorMessage(error)
        }
      }));
    }
  }, [api, setTextFileBuffers, textFileBuffers]);

  const reloadTextFileBuffer = useCallback(async (projectRelativePath: string) => {
    try {
      const file = await api.readProjectTextFile(projectRelativePath);
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: {
          projectRelativePath: file.projectRelativePath,
          content: file.content,
          language: file.language,
          wordWrap: buffers[projectRelativePath]?.wordWrap ?? false,
          dirty: false,
          saving: false,
          diskRevision: file.revision,
          lastSavedRevision: file.revision,
          externalChange: false
        }
      }));
    } catch (error) {
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: textBufferErrorState(projectRelativePath, buffers[projectRelativePath], error)
      }));
    }
  }, [api, setTextFileBuffers]);

  const discardTextFileBuffer = useCallback(async (projectRelativePath: string) => {
    await reloadTextFileBuffer(projectRelativePath);
  }, [reloadTextFileBuffer]);

  const refreshTextFileBuffer = useCallback(async (projectRelativePath: string) => {
    const current = textFileBuffersRef.current[projectRelativePath];
    const windowState = textEditorWindowsRef.current[projectRelativePath];
    if (!current && !windowState?.open) {
      return;
    }
    try {
      const file = await api.readProjectTextFile(projectRelativePath);
      setTextFileBuffers((buffers) => ({
        ...buffers,
        [projectRelativePath]: textBufferFromFile(file, buffers[projectRelativePath])
      }));
    } catch (error) {
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

function textBufferErrorState(projectRelativePath: string, current: TextFileBuffer | undefined, error: unknown): TextFileBuffer {
  return {
    projectRelativePath,
    content: current?.content ?? '',
    language: current?.language ?? 'plaintext',
    wordWrap: current?.wordWrap ?? false,
    dirty: current?.dirty ?? false,
    saving: false,
    ...(current?.diskRevision ? { diskRevision: current.diskRevision } : {}),
    ...(current?.lastSavedRevision ? { lastSavedRevision: current.lastSavedRevision } : {}),
    externalChange: current?.externalChange ?? false,
    error: errorMessage(error)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
