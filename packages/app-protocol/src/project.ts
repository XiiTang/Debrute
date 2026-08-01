export interface DebruteProjectMetadata {
  project: {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  };
}

export type ProjectPathKind = 'file' | 'directory';

export interface ProjectPathEntry {
  projectRelativePath: string;
  kind: ProjectPathKind;
  sizeBytes?: number;
}

export interface ProjectTextFile {
  projectRelativePath: string;
  absolutePath: string;
  content: string;
  size: number;
  mtimeMs: number;
  revision: string;
  language: ProjectTextLanguageId;
  mimeType: string;
}

export interface WriteProjectTextFileInput {
  projectRelativePath: string;
  content: string;
  expectedRevision: string;
}

export interface NormalizedFileWatchEvent {
  type: 'changed';
  absolutePath: string;
  projectRelativePath: string;
  observedAt?: number;
  affects: Array<
    | 'canvas'
    | 'canvas-registry'
    | 'canvas-map'
    | 'canvas-feedback'
    | 'project-metadata'
    | 'generated-asset-metadata'
    | 'content'
  >;
}

export interface ProjectPathBatchItemResult extends ProjectPathEntry {
  sourceProjectRelativePath: string;
  status: 'ok' | 'skipped';
}

export interface ProjectPathBatchOperationResult {
  results: ProjectPathBatchItemResult[];
}
import {
  PROJECT_TEXT_LANGUAGE_IDS,
  type ProjectTextLanguageId
} from '@debrute/canvas-core';

export { PROJECT_TEXT_LANGUAGE_IDS };
export type { ProjectTextLanguageId };
