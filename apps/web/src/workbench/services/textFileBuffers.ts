import type { WorkbenchProjectTextFile } from '@debrute/app-protocol';
import type { TextFileBuffer } from '../../types';

export function textBufferFromFile(file: WorkbenchProjectTextFile, current: TextFileBuffer | undefined): TextFileBuffer {
  if (current?.dirty && current.diskRevision === file.revision) {
    return {
      ...current,
      projectRelativePath: file.projectRelativePath,
      saving: false,
      externalChange: current.externalChange ?? false
    };
  }
  if (current?.dirty) {
    return {
      projectRelativePath: file.projectRelativePath,
      content: current.content,
      language: current.language,
      wordWrap: current.wordWrap,
      dirty: true,
      saving: false,
      diskRevision: file.revision,
      ...(current.lastSavedRevision ? { lastSavedRevision: current.lastSavedRevision } : {}),
      externalChange: true
    };
  }
  return {
    projectRelativePath: file.projectRelativePath,
    content: file.content,
    language: file.language,
    wordWrap: current?.wordWrap ?? false,
    dirty: false,
    saving: false,
    diskRevision: file.revision,
    lastSavedRevision: file.revision,
    externalChange: false
  };
}
