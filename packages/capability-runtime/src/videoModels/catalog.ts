export interface VideoModelCatalogEntry {
  debruteModelId: string;
  summary: string;
  chooseWhen: string;
  avoidWhen: string;
  supportsTextToVideo: boolean;
  supportsImageReferences: boolean;
  supportsVideoReferences: boolean;
  supportsAudioReferences: boolean;
  supportsGeneratedAudio: boolean;
  defaultBaseUrl: string;
  defaultRequestModelId: string;
  capabilities: Record<string, unknown>;
  argumentsSchema: Record<string, unknown>;
  usageNotes: string;
  requestExample: {
    command: 'generate.video';
    input: {
      model: string;
      arguments: Record<string, unknown>;
    };
  };
}

export interface VideoModelOverviewEntry {
  model: string;
  summary: string;
  chooseWhen: string;
  avoidWhen: string;
  capabilities: Record<string, unknown>;
  supportsTextToVideo: boolean;
  supportsImageReferences: boolean;
  supportsVideoReferences: boolean;
  supportsAudioReferences: boolean;
  supportsGeneratedAudio: boolean;
  requestShapeHint: {
    command: 'generate.video';
    requiredFields: ['model', 'arguments'];
  };
}

export interface VideoModelDetailEntry extends VideoModelOverviewEntry {
  argumentsSchema: Record<string, unknown>;
  referenceArgumentRules: Array<{ field: string; acceptedValueFormat: string }>;
  usageNotes: string;
  requestExample: VideoModelCatalogEntry['requestExample'];
}

const SEEDANCE_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'];
const SEEDANCE_USAGE_NOTES = [
  '`content` is required and uses the official Volcengine Ark content array.',
  'Image inputs accept http(s), data:image, asset://, or Project-relative image paths.',
  'Audio inputs accept http(s), data:audio, asset://, or Project-relative audio paths.',
  'Video inputs accept only http(s) or asset:// in Debrute V1; local video upload is out of scope.',
  'When audio input is present, include at least one reference image or reference video.',
  '`service_tier: flex` is not supported for the Seedance 2.0 series.'
].join(' ');

const ENTRIES: VideoModelCatalogEntry[] = [
  seedanceEntry('doubao-seedance-2-0-260128', {
    summary: 'Volcengine Ark Doubao Seedance 2.0 video generation.',
    chooseWhen: 'highest Seedance 2.0 quality, 1080p output, multimodal reference generation, generated audio',
    avoidWhen: 'you need the fastest or cheapest Seedance path',
    resolutions: ['480p', '720p', '1080p']
  }),
  seedanceEntry('doubao-seedance-2-0-fast-260128', {
    summary: 'Volcengine Ark Doubao Seedance 2.0 Fast video generation.',
    chooseWhen: 'faster Seedance 2.0 iterations up to 720p with multimodal references',
    avoidWhen: 'you need 1080p output',
    resolutions: ['480p', '720p']
  })
];

export function createVideoModelCatalog() {
  return {
    listAll(): VideoModelCatalogEntry[] {
      return sortedEntries(ENTRIES);
    },
    listConfigured(debruteModelIds: string[]): VideoModelCatalogEntry[] {
      const selected = new Set(debruteModelIds);
      return sortedEntries(ENTRIES.filter((entry) => selected.has(entry.debruteModelId)));
    },
    listOverviews(entries: VideoModelCatalogEntry[] = ENTRIES): VideoModelOverviewEntry[] {
      return sortedEntries(entries).map(toOverview);
    },
    details(modelIds: string[], entries: VideoModelCatalogEntry[] = ENTRIES): { details: VideoModelDetailEntry[]; unavailableModels: string[] } {
      const byId = new Map(entries.map((entry) => [entry.debruteModelId, entry]));
      const seen = new Set<string>();
      const details: VideoModelDetailEntry[] = [];
      const unavailableModels: string[] = [];
      for (const modelId of modelIds) {
        const normalized = modelId.trim();
        if (!normalized || seen.has(normalized)) {
          continue;
        }
        seen.add(normalized);
        const entry = byId.get(normalized);
        if (!entry) {
          unavailableModels.push(normalized);
          continue;
        }
        details.push(toDetail(entry));
      }
      return { details, unavailableModels };
    },
    get(debruteModelId: string): VideoModelCatalogEntry | undefined {
      return ENTRIES.find((entry) => entry.debruteModelId === debruteModelId);
    }
  };
}

function seedanceEntry(debruteModelId: string, input: { summary: string; chooseWhen: string; avoidWhen: string; resolutions: string[] }): VideoModelCatalogEntry {
  return {
    debruteModelId,
    summary: input.summary,
    chooseWhen: input.chooseWhen,
    avoidWhen: input.avoidWhen,
    supportsTextToVideo: true,
    supportsImageReferences: true,
    supportsVideoReferences: true,
    supportsAudioReferences: true,
    supportsGeneratedAudio: true,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultRequestModelId: debruteModelId,
    capabilities: {
      supports_multimodal_references: true,
      supports_generated_audio: true,
      supports_local_video_upload: false,
      resolutions: input.resolutions,
      ratios: SEEDANCE_RATIOS,
      duration: { minimum: 4, maximum: 15, model_selected: -1 }
    },
    argumentsSchema: objectSchema(input.resolutions),
    usageNotes: SEEDANCE_USAGE_NOTES,
    requestExample: {
      command: 'generate.video',
      input: {
        model: debruteModelId,
        arguments: {
          content: [{ type: 'text', text: 'A quiet product launch video with slow camera movement and synchronized ambient audio.' }],
          resolution: input.resolutions.includes('1080p') ? '1080p' : '720p',
          ratio: '16:9',
          duration: 5,
          generate_audio: true,
          watermark: false
        }
      }
    }
  };
}

function toOverview(entry: VideoModelCatalogEntry): VideoModelOverviewEntry {
  return {
    model: entry.debruteModelId,
    summary: entry.summary,
    chooseWhen: entry.chooseWhen,
    avoidWhen: entry.avoidWhen,
    capabilities: entry.capabilities,
    supportsTextToVideo: entry.supportsTextToVideo,
    supportsImageReferences: entry.supportsImageReferences,
    supportsVideoReferences: entry.supportsVideoReferences,
    supportsAudioReferences: entry.supportsAudioReferences,
    supportsGeneratedAudio: entry.supportsGeneratedAudio,
    requestShapeHint: { command: 'generate.video', requiredFields: ['model', 'arguments'] }
  };
}

function toDetail(entry: VideoModelCatalogEntry): VideoModelDetailEntry {
  return {
    ...toOverview(entry),
    argumentsSchema: entry.argumentsSchema,
    referenceArgumentRules: [
      { field: 'content[].image_url.url', acceptedValueFormat: 'http(s), data:image, asset://, or Project-relative image path' },
      { field: 'content[].audio_url.url', acceptedValueFormat: 'http(s), data:audio, asset://, or Project-relative audio path' },
      { field: 'content[].video_url.url', acceptedValueFormat: 'http(s) or asset:// only; local video files are not uploaded by Debrute V1' }
    ],
    usageNotes: entry.usageNotes,
    requestExample: entry.requestExample
  };
}

function sortedEntries(entries: VideoModelCatalogEntry[]): VideoModelCatalogEntry[] {
  return [...entries].sort((left, right) => left.debruteModelId.localeCompare(right.debruteModelId));
}

function objectSchema(resolutions: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      content: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Official Volcengine Ark content array.'
      },
      callback_url: { type: 'string' },
      return_last_frame: { type: 'boolean' },
      service_tier: { type: 'string' },
      execution_expires_after: { type: 'integer' },
      generate_audio: { type: 'boolean' },
      tools: { type: 'array', items: { type: 'object', additionalProperties: true } },
      safety_identifier: { type: 'string' },
      resolution: { type: 'string', enum: resolutions },
      ratio: { type: 'string', enum: SEEDANCE_RATIOS },
      duration: { type: 'integer', minimum: -1, maximum: 15 },
      frames: { type: 'integer' },
      seed: { type: ['integer', 'string', 'null'] },
      camera_fixed: { type: 'boolean' },
      watermark: { type: 'boolean' },
      output_path: {
        type: 'string',
        description: 'Optional project-relative output file path for the generated video.'
      },
      output_directory: {
        type: 'string',
        description: 'Optional project-relative directory for generated video files when output_path is not used.'
      }
    },
    required: ['content'],
    additionalProperties: false
  };
}
