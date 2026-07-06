import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runtimeOfficialDocSnapshotRoot } from '../../officialDocs/runtimeSnapshotRoot.js';
import {
  createAudioModelCatalog,
  type AudioModelCatalogEntry,
  type AudioModelKind
} from '../catalog.js';

export interface AudioModelOfficialDocReference {
  modelId: string;
  kind: AudioModelKind;
  sourceUrls: string[];
  snapshotPath: string;
  capturedAt: string;
  appliesToModels: string[];
}

export interface AudioModelOfficialDescription extends AudioModelOfficialDocReference {
  descriptionMarkdown: string;
}

export class AudioModelOfficialDocMissingError extends Error {
  readonly code = 'audio_model_official_doc_missing';
  readonly fields: { model: string; snapshot: string };

  constructor(modelId: string, snapshotPath: string) {
    super(`Official audio model documentation snapshot is unavailable: ${modelId}`);
    this.name = 'AudioModelOfficialDocMissingError';
    this.fields = { model: modelId, snapshot: snapshotPath };
  }
}

const CAPTURED_AT = '2026-07-06';
const SNAPSHOT_ROOT = 'packages/capability-runtime/src/audioModels/officialDocs/snapshots';
const CATALOG = createAudioModelCatalog();

const DOCS: AudioModelOfficialDocReference[] = [
  ...docsFor(['openai-gpt-4o-mini-tts', 'openai-tts-1', 'openai-tts-1-hd'], {
    sourceUrls: [
      'https://developers.openai.com/api/docs/guides/text-to-speech',
      'https://developers.openai.com/api/docs/models/gpt-4o-mini-tts'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/openai/tts.md`
  }),
  ...docsFor(['elevenlabs-v3-tts', 'elevenlabs-multilingual-v2'], {
    sourceUrls: ['https://elevenlabs.io/docs/api-reference/text-to-speech/convert'],
    snapshotPath: `${SNAPSHOT_ROOT}/elevenlabs/tts.md`
  }),
  ...docsFor(['elevenlabs-music'], {
    sourceUrls: ['https://elevenlabs.io/docs/api-reference/music/compose'],
    snapshotPath: `${SNAPSHOT_ROOT}/elevenlabs/music.md`
  }),
  ...docsFor(['elevenlabs-sound-effects'], {
    sourceUrls: ['https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert'],
    snapshotPath: `${SNAPSHOT_ROOT}/elevenlabs/sound-effects.md`
  }),
  ...docsFor(['gemini-tts'], {
    sourceUrls: [
      'https://ai.google.dev/gemini-api/docs/speech-generation',
      'https://ai.google.dev/api/interactions-api'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/google-gemini/tts.md`
  }),
  ...docsFor(['google-lyria-3-clip-preview', 'google-lyria-3-pro-preview'], {
    sourceUrls: [
      'https://ai.google.dev/gemini-api/docs/music-generation',
      'https://ai.google.dev/api/interactions-api'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/google-gemini/lyria.md`
  }),
  ...docsFor(['minimax-speech-2-8-hd'], {
    sourceUrls: ['https://platform.minimax.io/docs/api-reference/speech-t2a-http'],
    snapshotPath: `${SNAPSHOT_ROOT}/minimax/t2a-http.md`
  }),
  ...docsFor(['minimax-music-2-6'], {
    sourceUrls: ['https://platform.minimax.io/docs/api-reference/music-generation'],
    snapshotPath: `${SNAPSHOT_ROOT}/minimax/music-generation.md`
  }),
  ...docsFor(['dashscope-qwen3-tts-flash'], {
    sourceUrls: [
      'https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api',
      'https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/dashscope/qwen-tts.md`
  }),
  ...docsFor(['doubao-seed-tts-2-0'], {
    sourceUrls: [
      'https://www.volcengine.com/docs/82379/2516286',
      'https://www.volcengine.com/docs/6561/1329505'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/volcengine/seed-tts.md`
  }),
  ...docsFor(['fal-stable-audio-text-to-audio', 'fal-stable-audio-sfx'], {
    sourceUrls: [
      'https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio',
      'https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio/api',
      'https://fal.ai/models/fal-ai/stable-audio-3/medium/base/text-to-audio/api',
      'https://fal.ai/docs/documentation/model-apis/inference/queue'
    ],
    snapshotPath: `${SNAPSHOT_ROOT}/fal/stable-audio.md`
  })
];

const DOCS_BY_MODEL_ID = new Map(DOCS.map((doc) => [doc.modelId, doc]));
const CATALOG_REQUEST_EXAMPLES_BY_MODEL_ID = new Map(
  CATALOG.listAll().map((entry) => [entry.debruteModelId, entry.requestExample.input])
);

export function listAudioModelOfficialDocs(): AudioModelOfficialDocReference[] {
  return DOCS.map(publicDocReference).sort((left, right) => left.modelId.localeCompare(right.modelId));
}

export async function describeAudioModelOfficialDoc(modelId: string): Promise<AudioModelOfficialDescription | undefined> {
  const doc = DOCS_BY_MODEL_ID.get(modelId);
  if (!doc) {
    return undefined;
  }
  let snapshot: string;
  try {
    snapshot = await readSnapshot(doc);
  } catch {
    throw new AudioModelOfficialDocMissingError(modelId, doc.snapshotPath);
  }
  return {
    ...publicDocReference(doc),
    descriptionMarkdown: descriptionMarkdown(doc, snapshot)
  };
}

function docsFor(
  modelIds: string[],
  input: { sourceUrls: string[]; snapshotPath: string }
): AudioModelOfficialDocReference[] {
  return modelIds.map((modelId) => {
    const entry = CATALOG.get(modelId);
    if (!entry) {
      throw new Error(`Audio model official docs reference unknown catalog model: ${modelId}`);
    }
    return {
      modelId,
      kind: entry.kind,
      sourceUrls: input.sourceUrls,
      snapshotPath: input.snapshotPath,
      capturedAt: CAPTURED_AT,
      appliesToModels: modelIds
    };
  });
}

function publicDocReference(doc: AudioModelOfficialDocReference): AudioModelOfficialDocReference {
  return {
    modelId: doc.modelId,
    kind: doc.kind,
    sourceUrls: [...doc.sourceUrls],
    snapshotPath: doc.snapshotPath,
    capturedAt: doc.capturedAt,
    appliesToModels: [...doc.appliesToModels]
  };
}

function descriptionMarkdown(doc: AudioModelOfficialDocReference, snapshot: string): string {
  const officialUrls = doc.sourceUrls.map((url) => `- ${url}`).join('\n');
  const body = stripFrontmatter(snapshot).trim();
  const debruteInputJson = JSON.stringify(debruteExampleInput(doc));
  const command = commandForKind(doc.kind);

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
    'Audio request timeout covers task submission, polling when the official API is task-based, response reads, artifact download, and artifact write. Use `--timeout-ms <ms>` to override it.',
    '',
    '```sh',
    `debrute ${command.replace('.', ' ')} <project> --input-json '${debruteInputJson}' --timeout-ms 600000`,
    '```'
  ].join('\n');
}

function commandForKind(kind: AudioModelKind): 'generate.tts' | 'generate.music' | 'generate.sfx' {
  if (kind === 'tts') {
    return 'generate.tts';
  }
  return kind === 'music' ? 'generate.music' : 'generate.sfx';
}

function debruteExampleInput(doc: AudioModelOfficialDocReference): AudioModelCatalogEntry['requestExample']['input'] {
  const exampleInput = CATALOG_REQUEST_EXAMPLES_BY_MODEL_ID.get(doc.modelId);
  if (!exampleInput) {
    throw new Error(`Audio model catalog request example is missing: ${doc.modelId}`);
  }
  return exampleInput;
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

async function readSnapshot(doc: AudioModelOfficialDocReference): Promise<string> {
  return readFile(resolve(runtimeSnapshotRoot(), doc.snapshotPath.slice(`${SNAPSHOT_ROOT}/`.length)), 'utf8');
}

function runtimeSnapshotRoot(): string {
  return runtimeOfficialDocSnapshotRoot({
    modelKind: 'audioModels',
    importMetaUrl: import.meta.url,
    ...(typeof __dirname === 'string' ? { moduleDir: __dirname } : {})
  });
}
