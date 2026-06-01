import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImageModelCatalog, type ImageModelCatalogEntry } from '../catalog.js';

export interface ImageModelOfficialDocReference {
  modelId: string;
  provider: string;
  sourceUrls: string[];
  snapshotPath: string;
  capturedAt: string;
  appliesToModels: string[];
}

export interface ImageModelOfficialDescription extends ImageModelOfficialDocReference {
  descriptionMarkdown: string;
}

type InternalImageModelOfficialDocReference = ImageModelOfficialDocReference;

export class ImageModelOfficialDocMissingError extends Error {
  readonly code = 'image_model_official_doc_missing';
  readonly fields: { model: string; snapshot: string };

  constructor(modelId: string, snapshotPath: string) {
    super(`Official image model documentation snapshot is unavailable: ${modelId}`);
    this.name = 'ImageModelOfficialDocMissingError';
    this.fields = { model: modelId, snapshot: snapshotPath };
  }
}

const CAPTURED_AT = '2026-05-31';
const SNAPSHOT_ROOT = 'packages/capability-runtime/src/imageModels/officialDocs/snapshots';

const DOCS: InternalImageModelOfficialDocReference[] = [
  {
    modelId: 'doubao-seedream-5-0-lite-260128',
    provider: 'volcengine-ark',
    sourceUrls: [
      'https://www.volcengine.com/docs/82379/1541523',
      'https://www.volcengine.com/docs/82379/1824692'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/volcengine-ark/seedream-5-lite.md`,
    capturedAt: CAPTURED_AT,
    appliesToModels: ['doubao-seedream-5-0-lite-260128']
  },
  {
    modelId: 'fal-ai/flux/dev',
    provider: 'fal',
    sourceUrls: ['https://fal.ai/models/fal-ai/flux/dev/api'],
    snapshotPath: `${SNAPSHOT_ROOT}/fal/flux-dev.md`,
    capturedAt: CAPTURED_AT,
    appliesToModels: ['fal-ai/flux/dev']
  },
  {
    modelId: 'fal-ai/flux/dev/image-to-image',
    provider: 'fal',
    sourceUrls: ['https://fal.ai/models/fal-ai/flux/dev/image-to-image/api'],
    snapshotPath: `${SNAPSHOT_ROOT}/fal/flux-dev-image-to-image.md`,
    capturedAt: CAPTURED_AT,
    appliesToModels: ['fal-ai/flux/dev/image-to-image']
  },
  {
    modelId: 'gemini-3-pro-image-preview',
    provider: 'google-gemini',
    sourceUrls: [
      'https://ai.google.dev/gemini-api/docs/image-generation',
      'https://deepmind.google/models/model-cards/gemini-3-1-flash-image/'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/google-gemini/image-generation.md`,
    capturedAt: CAPTURED_AT,
    appliesToModels: ['gemini-3-pro-image-preview', 'gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview']
  },
  {
    modelId: 'gemini-3.1-flash-image',
    provider: 'google-gemini',
    sourceUrls: [
      'https://ai.google.dev/gemini-api/docs/image-generation',
      'https://deepmind.google/models/model-cards/gemini-3-1-flash-image/'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/google-gemini/image-generation.md`,
    capturedAt: CAPTURED_AT,
    appliesToModels: ['gemini-3-pro-image-preview', 'gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview']
  },
  {
    modelId: 'gemini-3.1-flash-image-preview',
    provider: 'google-gemini',
    sourceUrls: [
      'https://ai.google.dev/gemini-api/docs/image-generation',
      'https://deepmind.google/models/model-cards/gemini-3-1-flash-image/'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/google-gemini/image-generation.md`,
    capturedAt: CAPTURED_AT,
    appliesToModels: ['gemini-3-pro-image-preview', 'gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview']
  },
  {
    modelId: 'gpt-image-1',
    provider: 'openai',
    sourceUrls: [
      'https://developers.openai.com/api/docs/guides/image-generation',
      'https://developers.openai.com/api/docs/models/gpt-image-1'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/openai/image-generation.md`,
    capturedAt: CAPTURED_AT,
    appliesToModels: ['gpt-image-1', 'gpt-image-2']
  },
  {
    modelId: 'gpt-image-2',
    provider: 'openai',
    sourceUrls: [
      'https://developers.openai.com/api/docs/guides/image-generation',
      'https://developers.openai.com/api/docs/models/gpt-image-2'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/openai/image-generation.md`,
    capturedAt: CAPTURED_AT,
    appliesToModels: ['gpt-image-1', 'gpt-image-2']
  },
  {
    modelId: 'grok-imagine',
    provider: 'vydra',
    sourceUrls: [
      'https://www.vydra.ai/docs/models/grok-imagine',
      'https://docs.x.ai/developers/model-capabilities/images/generation?campaign=imagine-ads-generation'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/vydra/grok-imagine.md`,
    capturedAt: CAPTURED_AT,
    appliesToModels: ['grok-imagine']
  },
  {
    modelId: 'image-01',
    provider: 'minimax',
    sourceUrls: [
      'https://platform.minimax.io/docs/api-reference/image-generation-t2i',
      'https://platform.minimax.io/docs/api-reference/image-generation-i2i',
      'https://platform.minimax.io/docs/guides/image-generation'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/minimax/image-01.md`,
    capturedAt: CAPTURED_AT,
    appliesToModels: ['image-01']
  },
  {
    modelId: 'wan2.7-image',
    provider: 'dashscope',
    sourceUrls: ['https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference'],
    snapshotPath: `${SNAPSHOT_ROOT}/dashscope/wan2.7-image.md`,
    capturedAt: CAPTURED_AT,
    appliesToModels: ['wan2.7-image']
  }
];

const DOCS_BY_MODEL_ID = new Map(DOCS.map((doc) => [doc.modelId, doc]));
const CATALOG_REQUEST_EXAMPLES_BY_MODEL_ID = new Map(
  createImageModelCatalog().listAll().map((entry) => [entry.axisModelId, entry.requestExample.input])
);

export function listImageModelOfficialDocs(): ImageModelOfficialDocReference[] {
  return DOCS.map(publicDocReference).sort((left, right) => left.modelId.localeCompare(right.modelId));
}

export async function describeImageModelOfficialDoc(modelId: string): Promise<ImageModelOfficialDescription | undefined> {
  const doc = DOCS_BY_MODEL_ID.get(modelId);
  if (!doc) {
    return undefined;
  }
  let snapshot: string;
  try {
    snapshot = await readSnapshot(doc);
  } catch {
    throw new ImageModelOfficialDocMissingError(modelId, doc.snapshotPath);
  }
  return {
    ...publicDocReference(doc),
    descriptionMarkdown: descriptionMarkdown(doc, snapshot)
  };
}

function publicDocReference(doc: InternalImageModelOfficialDocReference): ImageModelOfficialDocReference {
  return {
    modelId: doc.modelId,
    provider: doc.provider,
    sourceUrls: [...doc.sourceUrls],
    snapshotPath: doc.snapshotPath,
    capturedAt: doc.capturedAt,
    appliesToModels: [...doc.appliesToModels]
  };
}

function descriptionMarkdown(doc: InternalImageModelOfficialDocReference, snapshot: string): string {
  const officialUrls = doc.sourceUrls.map((url) => `- ${url}`).join('\n');
  const body = stripFrontmatter(snapshot).trim();
  const axisInputJson = JSON.stringify(axisExampleInput(doc));

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
    '## AXIS command',
    '',
    '```sh',
    `axis generate image <project> --input-json '${axisInputJson}'`,
    '```'
  ].join('\n');
}

function axisExampleInput(doc: InternalImageModelOfficialDocReference): ImageModelCatalogEntry['requestExample']['input'] {
  const exampleInput = CATALOG_REQUEST_EXAMPLES_BY_MODEL_ID.get(doc.modelId);
  if (!exampleInput) {
    throw new Error(`Image model catalog request example is missing: ${doc.modelId}`);
  }
  return exampleInput;
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

async function readSnapshot(doc: InternalImageModelOfficialDocReference): Promise<string> {
  return readFile(resolve(runtimeSnapshotRoot(), doc.snapshotPath.slice(`${SNAPSHOT_ROOT}/`.length)), 'utf8');
}

function runtimeSnapshotRoot(): string {
  if (typeof __dirname === 'string' && __dirname.endsWith(`${sep}dist-electron`)) {
    return resolve(__dirname, 'snapshots');
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), 'snapshots');
}
