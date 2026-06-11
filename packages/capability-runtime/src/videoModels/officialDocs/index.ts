import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runtimeOfficialDocSnapshotRoot } from '../../officialDocs/runtimeSnapshotRoot.js';
import { createVideoModelCatalog, type VideoModelCatalogEntry } from '../catalog.js';

export interface VideoModelOfficialDocReference {
  modelId: string;
  sourceUrls: string[];
  snapshotPath: string;
  capturedAt: string;
  appliesToModels: string[];
}

export interface VideoModelOfficialDescription extends VideoModelOfficialDocReference {
  descriptionMarkdown: string;
}

export class VideoModelOfficialDocMissingError extends Error {
  readonly code = 'video_model_official_doc_missing';
  readonly fields: { model: string; snapshot: string };

  constructor(modelId: string, snapshotPath: string) {
    super(`Official video model documentation snapshot is unavailable: ${modelId}`);
    this.name = 'VideoModelOfficialDocMissingError';
    this.fields = { model: modelId, snapshot: snapshotPath };
  }
}

const CAPTURED_AT = '2026-06-09';
const SNAPSHOT_ROOT = 'packages/capability-runtime/src/videoModels/officialDocs/snapshots';
const SOURCE_URLS = [
  'https://www.volcengine.com/docs/82379/2291680',
  'https://www.volcengine.com/docs/82379/1520757',
  'https://www.volcengine.com/docs/82379/1521309',
  'https://www.volcengine.com/docs/82379/1159178'
];

const DOCS: VideoModelOfficialDocReference[] = [
  {
    modelId: 'doubao-seedance-2-0-260128',
    sourceUrls: SOURCE_URLS,
    snapshotPath: `${SNAPSHOT_ROOT}/volcengine-ark/seedance-2.md`,
    capturedAt: CAPTURED_AT,
    appliesToModels: ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128']
  },
  {
    modelId: 'doubao-seedance-2-0-fast-260128',
    sourceUrls: SOURCE_URLS,
    snapshotPath: `${SNAPSHOT_ROOT}/volcengine-ark/seedance-2.md`,
    capturedAt: CAPTURED_AT,
    appliesToModels: ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128']
  }
];

const DOCS_BY_MODEL_ID = new Map(DOCS.map((doc) => [doc.modelId, doc]));
const CATALOG_REQUEST_EXAMPLES_BY_MODEL_ID = new Map(
  createVideoModelCatalog().listAll().map((entry) => [entry.debruteModelId, entry.requestExample.input])
);

export function listVideoModelOfficialDocs(): VideoModelOfficialDocReference[] {
  return DOCS.map(publicDocReference).sort((left, right) => left.modelId.localeCompare(right.modelId));
}

export async function describeVideoModelOfficialDoc(modelId: string): Promise<VideoModelOfficialDescription | undefined> {
  const doc = DOCS_BY_MODEL_ID.get(modelId);
  if (!doc) {
    return undefined;
  }
  let snapshot: string;
  try {
    snapshot = await readSnapshot(doc);
  } catch {
    throw new VideoModelOfficialDocMissingError(modelId, doc.snapshotPath);
  }
  return {
    ...publicDocReference(doc),
    descriptionMarkdown: descriptionMarkdown(doc, snapshot)
  };
}

function publicDocReference(doc: VideoModelOfficialDocReference): VideoModelOfficialDocReference {
  return {
    modelId: doc.modelId,
    sourceUrls: [...doc.sourceUrls],
    snapshotPath: doc.snapshotPath,
    capturedAt: doc.capturedAt,
    appliesToModels: [...doc.appliesToModels]
  };
}

function descriptionMarkdown(doc: VideoModelOfficialDocReference, snapshot: string): string {
  const officialUrls = doc.sourceUrls.map((url) => `- ${url}`).join('\n');
  const body = stripFrontmatter(snapshot).trim();
  const debruteInputJson = JSON.stringify(debruteExampleInput(doc));

  return [
    `# ${doc.modelId}`,
    '',
    'Official documentation:',
    officialUrls,
    '',
    'Repository snapshot:',
    `- ${doc.snapshotPath}`,
    '',
    body,
    '',
    '## Debrute command',
    '',
    'Video request timeout defaults to 600000ms for task submission, polling, response reads, and artifact download. Use `--timeout-ms <ms>` to override it.',
    '',
    '```sh',
    `debrute generate video <project> --input-json '${debruteInputJson}' --timeout-ms 600000`,
    '```'
  ].join('\n');
}

function debruteExampleInput(doc: VideoModelOfficialDocReference): VideoModelCatalogEntry['requestExample']['input'] {
  const exampleInput = CATALOG_REQUEST_EXAMPLES_BY_MODEL_ID.get(doc.modelId);
  if (!exampleInput) {
    throw new Error(`Video model catalog request example is missing: ${doc.modelId}`);
  }
  return exampleInput;
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

async function readSnapshot(doc: VideoModelOfficialDocReference): Promise<string> {
  return readFile(resolve(runtimeSnapshotRoot(), doc.snapshotPath.slice(`${SNAPSHOT_ROOT}/`.length)), 'utf8');
}

function runtimeSnapshotRoot(): string {
  return runtimeOfficialDocSnapshotRoot({
    modelKind: 'videoModels',
    importMetaUrl: import.meta.url,
    ...(typeof __dirname === 'string' ? { moduleDir: __dirname } : {})
  });
}
