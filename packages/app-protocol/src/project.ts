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
}

export const PROJECT_TEXT_LANGUAGE_IDS = [
  'plaintext',
  'markdown',
  'json',
  'jsonc',
  'jsonl',
  'yaml',
  'shell',
  'dotenv',
  'ini',
  'properties',
  'log',
  'html',
  'css',
  'scss',
  'less',
  'xml',
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
  'python',
  'ruby',
  'php',
  'sql',
  'powershell',
  'bat',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'lua',
  'perl',
  'r',
  'dockerfile',
  'makefile',
  'diff',
  'csv',
  'tsv',
  'subtitle',
  'webvtt',
  'toml',
  'tex',
  'textile',
  'protobuf',
  'restructuredtext',
  'asciidoc',
  'org'
] as const;

export type ProjectTextLanguageId = typeof PROJECT_TEXT_LANGUAGE_IDS[number];

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
