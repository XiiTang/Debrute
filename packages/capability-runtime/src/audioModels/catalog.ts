export type AudioModelKind = 'tts' | 'music' | 'sound-effect';

export interface AudioModelCatalogEntry {
  debruteModelId: string;
  kind: AudioModelKind;
  summary: string;
  chooseWhen: string;
  avoidWhen: string;
  defaultBaseUrl: string;
  defaultRequestModelId: string;
  listParameters: Record<string, string>;
  capabilities: Record<string, unknown>;
  argumentsSchema: Record<string, unknown>;
  usageNotes: string;
  requestExample: {
    command: 'generate.tts' | 'generate.music' | 'generate.sfx';
    input: {
      model: string;
      arguments: Record<string, unknown>;
    };
  };
}

export interface AudioModelOverviewEntry {
  model: string;
  kind: AudioModelKind;
  summary: string;
  chooseWhen: string;
  avoidWhen: string;
  capabilities: Record<string, unknown>;
  requestShapeHint: {
    command: 'generate.tts' | 'generate.music' | 'generate.sfx';
    requiredFields: ['model', 'arguments'];
  };
}

export interface AudioModelDetailEntry extends AudioModelOverviewEntry {
  argumentsSchema: Record<string, unknown>;
  usageNotes: string;
  requestExample: AudioModelCatalogEntry['requestExample'];
}

const ENTRIES: AudioModelCatalogEntry[] = [
  ttsEntry('openai-gpt-4o-mini-tts', {
    summary: 'OpenAI GPT-4o mini TTS text-to-speech.',
    chooseWhen: 'controllable narration with promptable speaking style',
    avoidWhen: 'you need local-only synthesis',
    baseUrl: 'https://api.openai.com/v1',
    requestModelId: 'gpt-4o-mini-tts',
    capabilities: {
      voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'],
      formats: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'],
      supports_instructions: true
    },
    example: { text: 'Welcome to Debrute.', voice: 'alloy', format: 'mp3', output_path: 'generated/voiceover.mp3' },
    listParameters: ttsListParameters({
      voice: 'OpenAI voice id',
      format: 'mp3|opus|aac|flac|wav|pcm',
      speed: 'optional speaking speed',
      instructions: 'optional style control'
    }),
    argumentsSchema: ttsModelSchema({
      voice: { type: 'string' },
      format: { type: 'string', enum: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] },
      speed: { type: 'number' },
      instructions: { type: 'string' }
    })
  }),
  ttsEntry('openai-tts-1', {
    summary: 'OpenAI tts-1 low-latency text-to-speech.',
    chooseWhen: 'lower latency OpenAI TTS is preferred over maximum quality',
    avoidWhen: 'you need promptable speaking style instructions',
    baseUrl: 'https://api.openai.com/v1',
    requestModelId: 'tts-1',
    capabilities: {
      voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
      formats: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'],
      supports_instructions: false
    },
    example: { text: 'Welcome to Debrute.', voice: 'alloy', format: 'mp3' },
    listParameters: ttsListParameters({
      voice: 'OpenAI voice id',
      format: 'mp3|opus|aac|flac|wav|pcm',
      speed: 'optional speaking speed'
    }),
    argumentsSchema: ttsModelSchema({
      voice: { type: 'string' },
      format: { type: 'string', enum: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] },
      speed: { type: 'number' }
    })
  }),
  ttsEntry('openai-tts-1-hd', {
    summary: 'OpenAI tts-1-hd higher-quality text-to-speech.',
    chooseWhen: 'OpenAI TTS quality matters more than latency',
    avoidWhen: 'you need promptable speaking style instructions',
    baseUrl: 'https://api.openai.com/v1',
    requestModelId: 'tts-1-hd',
    capabilities: {
      voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
      formats: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'],
      supports_instructions: false
    },
    example: { text: 'Welcome to Debrute.', voice: 'nova', format: 'mp3' },
    listParameters: ttsListParameters({
      voice: 'OpenAI voice id',
      format: 'mp3|opus|aac|flac|wav|pcm',
      speed: 'optional speaking speed'
    }),
    argumentsSchema: ttsModelSchema({
      voice: { type: 'string' },
      format: { type: 'string', enum: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] },
      speed: { type: 'number' }
    })
  }),
  ttsEntry('elevenlabs-v3-tts', {
    summary: 'ElevenLabs v3 text-to-speech.',
    chooseWhen: 'expressive ElevenLabs voice generation is desired',
    avoidWhen: 'you do not have a configured ElevenLabs voice id',
    baseUrl: 'https://api.elevenlabs.io/v1',
    requestModelId: 'eleven_v3',
    capabilities: {
      supports_voice_settings: true,
      formats: ['mp3', 'wav'],
      requires_voice_id: true
    },
    example: { text: 'A cinematic narration line.', voice_id: 'JBFqnCBsd6RMkjVDRZzb', format: 'mp3' },
    listParameters: elevenLabsTtsListParameters(),
    argumentsSchema: elevenLabsTtsSchema()
  }),
  ttsEntry('elevenlabs-multilingual-v2', {
    summary: 'ElevenLabs multilingual v2 text-to-speech.',
    chooseWhen: 'multilingual ElevenLabs narration is needed',
    avoidWhen: 'you do not have a configured ElevenLabs voice id',
    baseUrl: 'https://api.elevenlabs.io/v1',
    requestModelId: 'eleven_multilingual_v2',
    capabilities: {
      supports_voice_settings: true,
      formats: ['mp3', 'wav'],
      requires_voice_id: true
    },
    example: { text: 'A concise multilingual narration line.', voice_id: 'JBFqnCBsd6RMkjVDRZzb', format: 'mp3' },
    listParameters: elevenLabsTtsListParameters(),
    argumentsSchema: elevenLabsTtsSchema()
  }),
  ttsEntry('gemini-tts', {
    summary: 'Gemini text-to-speech through the Gemini API.',
    chooseWhen: 'Gemini-controlled single-speaker or multi-speaker TTS is desired',
    avoidWhen: 'you need a ready MP3 response without PCM wrapping',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requestModelId: 'gemini-2.5-flash-preview-tts',
    capabilities: {
      formats: ['wav'],
      response_audio_encoding: 'pcm',
      default_sample_rate: 24000
    },
    example: { text: 'Say warmly: Welcome to Debrute.', voice: 'Kore' },
    listParameters: ttsListParameters({
      voice: 'Gemini TTS voice name',
      instructions: 'optional style instruction prepended to text'
    }),
    argumentsSchema: ttsModelSchema({
      voice: { type: 'string' },
      instructions: { type: 'string' }
    })
  }),
  ttsEntry('minimax-speech-2-8-hd', {
    summary: 'MiniMax Speech 2.8 HD HTTP text-to-audio.',
    chooseWhen: 'MiniMax high-definition TTS is configured',
    avoidWhen: 'you need a non-MiniMax voice catalog',
    baseUrl: 'https://api.minimax.io',
    requestModelId: 'speech-2.8-hd',
    capabilities: {
      formats: ['mp3', 'wav', 'flac'],
      supports_voice_settings: true
    },
    example: { text: 'Welcome to Debrute.', voice: 'male-qn-qingse', format: 'mp3' },
    listParameters: ttsListParameters({
      voice: 'MiniMax voice id',
      format: 'mp3|wav|flac',
      speed: 'optional voice_setting.speed number',
      pitch: 'optional voice_setting.pitch number',
      sample_rate: 'optional audio_setting.sample_rate number',
      bitrate: 'optional audio_setting.bitrate number'
    }),
    argumentsSchema: ttsModelSchema({
      voice: { type: 'string' },
      format: { type: 'string', enum: ['mp3', 'wav', 'flac'] },
      speed: { type: 'number' },
      pitch: { type: 'number' },
      sample_rate: { type: 'number' },
      bitrate: { type: 'number' }
    })
  }),
  ttsEntry('dashscope-qwen3-tts-flash', {
    summary: 'Alibaba Cloud DashScope Qwen3 TTS Flash.',
    chooseWhen: 'Qwen TTS through DashScope is configured',
    avoidWhen: 'you need local-only synthesis',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    requestModelId: 'qwen3-tts-flash',
    capabilities: {
      formats: ['wav'],
      supports_multilingual_text: true
    },
    example: { text: 'Welcome to Debrute.', voice: 'Cherry' },
    listParameters: ttsListParameters({
      voice: 'DashScope Qwen TTS voice',
      language: 'optional DashScope language_type'
    }),
    argumentsSchema: ttsModelSchema({
      voice: { type: 'string' },
      language: { type: 'string' }
    })
  }),
  ttsEntry('doubao-seed-tts-2-0', {
    summary: 'Volcengine Seed TTS 2.0 text-to-speech.',
    chooseWhen: 'Doubao/Volcengine Seed TTS is configured',
    avoidWhen: 'you need shared credentials across multiple Debrute model ids',
    baseUrl: 'https://openspeech.bytedance.com/api/v3',
    requestModelId: 'seed-tts-2.0',
    capabilities: {
      formats: ['mp3', 'wav', 'pcm'],
      supports_voice_type: true
    },
    example: { text: 'Welcome to Debrute.', voice: 'BV700_V2_streaming', format: 'mp3' },
    listParameters: ttsListParameters({
      voice: 'Volcengine speaker id',
      format: 'mp3|wav|pcm',
      sample_rate: 'optional req_params.audio_params.sample_rate number'
    }),
    argumentsSchema: ttsModelSchema({
      voice: { type: 'string' },
      format: { type: 'string', enum: ['mp3', 'wav', 'pcm'] },
      sample_rate: { type: 'number' }
    })
  }),
  musicEntry('elevenlabs-music', {
    summary: 'ElevenLabs text-to-music generation.',
    chooseWhen: 'prompted music generation through ElevenLabs is desired',
    avoidWhen: 'you need an open local workflow',
    baseUrl: 'https://api.elevenlabs.io/v1',
    requestModelId: 'music_v2',
    capabilities: {
      formats: ['mp3'],
      supports_duration: true,
      supports_seed: true
    },
    example: {
      prompt: 'Warm ambient electronic music for a product demo.',
      duration_seconds: 30,
      format: 'mp3',
      output_path: 'generated/demo-music.mp3'
    },
    listParameters: elevenLabsMusicListParameters(),
    argumentsSchema: elevenLabsMusicSchema()
  }),
  musicEntry('google-lyria-3-clip-preview', {
    summary: 'Google Lyria 3 clip preview music generation.',
    chooseWhen: 'Gemini API Lyria short music generation is configured',
    avoidWhen: 'you need a non-preview model',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requestModelId: 'lyria-3-clip-preview',
    capabilities: {
      formats: ['mp3']
    },
    example: { prompt: 'A bright synth pop loop for a product reveal.' },
    listParameters: promptListParameters('required music prompt', {}),
    argumentsSchema: promptModelSchema({})
  }),
  musicEntry('google-lyria-3-pro-preview', {
    summary: 'Google Lyria 3 pro preview music generation.',
    chooseWhen: 'higher-capability Gemini API Lyria generation is configured',
    avoidWhen: 'you need a stable non-preview model',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requestModelId: 'lyria-3-pro-preview',
    capabilities: {
      formats: ['mp3', 'wav']
    },
    example: { prompt: 'Cinematic orchestral underscore with hopeful momentum.', format: 'wav' },
    listParameters: promptListParameters('required music prompt', {
      format: 'mp3|wav'
    }),
    argumentsSchema: promptModelSchema({
      format: { type: 'string', enum: ['mp3', 'wav'] }
    })
  }),
  musicEntry('minimax-music-2-6', {
    summary: 'MiniMax Music 2.6 generation.',
    chooseWhen: 'MiniMax music generation is configured',
    avoidWhen: 'you need sound effects instead of music',
    baseUrl: 'https://api.minimax.io',
    requestModelId: 'music-2.6',
    capabilities: {
      formats: ['mp3'],
      supports_lyrics: true,
      supports_instrumental: true
    },
    example: { prompt: 'Upbeat technology demo music.', format: 'mp3', instrumental: true },
    listParameters: promptListParameters('required music prompt', {
      lyrics: 'optional lyrics',
      instrumental: 'optional is_instrumental boolean',
      format: 'mp3|wav|flac',
      sample_rate: 'optional audio_setting.sample_rate number',
      bitrate: 'optional audio_setting.bitrate number'
    }),
    argumentsSchema: promptModelSchema({
      lyrics: { type: 'string' },
      instrumental: { type: 'boolean' },
      format: { type: 'string', enum: ['mp3', 'wav', 'flac'] },
      sample_rate: { type: 'number' },
      bitrate: { type: 'number' }
    })
  }),
  musicEntry('fal-stable-audio-text-to-audio', {
    summary: 'fal Stable Audio text-to-audio music generation.',
    chooseWhen: 'Stable Audio generation through fal is configured',
    avoidWhen: 'you need a dedicated TTS voice model',
    baseUrl: 'https://queue.fal.run',
    requestModelId: 'fal-ai/stable-audio-25/text-to-audio',
    capabilities: {
      formats: ['wav'],
      supports_music_and_sfx: true
    },
    example: { prompt: 'Ambient downtempo music with soft pads.', duration_seconds: 20, output_path: 'generated/stable-audio.wav' },
    listParameters: promptListParameters('required music prompt', {
      duration_seconds: 'optional seconds_total number',
      seed: 'optional seed number'
    }),
    argumentsSchema: promptModelSchema({
      duration_seconds: { type: 'number' },
      seed: { type: 'number' }
    })
  }),
  soundEffectEntry('elevenlabs-sound-effects', {
    summary: 'ElevenLabs text-to-sound-effects generation.',
    chooseWhen: 'short sound effects through ElevenLabs are needed',
    avoidWhen: 'you need full music composition',
    baseUrl: 'https://api.elevenlabs.io/v1',
    requestModelId: 'eleven_text_to_sound_v2',
    capabilities: {
      formats: ['mp3'],
      supports_duration: true
    },
    example: {
      prompt: 'A clean futuristic notification chime.',
      duration_seconds: 2,
      format: 'mp3',
      output_path: 'generated/chime.mp3'
    },
    listParameters: promptListParameters('required sound effect prompt', {
      duration_seconds: 'optional duration_seconds number',
      format: 'mp3',
      loop: 'optional loop boolean'
    }),
    argumentsSchema: promptModelSchema({
      duration_seconds: { type: 'number' },
      format: { type: 'string', enum: ['mp3'] },
      loop: { type: 'boolean' }
    })
  }),
  soundEffectEntry('fal-stable-audio-sfx', {
    summary: 'fal Stable Audio text-to-audio for sound effects.',
    chooseWhen: 'Stable Audio is desired for sound effects or ambience',
    avoidWhen: 'you need TTS or lyric music generation',
    baseUrl: 'https://queue.fal.run',
    requestModelId: 'fal-ai/stable-audio-3/medium/base/text-to-audio',
    capabilities: {
      formats: ['mp3', 'wav'],
      supports_music_and_sfx: true
    },
    example: { prompt: 'A distant sci-fi door opening with a soft hydraulic hiss.', duration_seconds: 4, format: 'mp3' },
    listParameters: promptListParameters('required sound effect prompt', {
      duration_seconds: 'optional duration number',
      format: 'mp3|wav',
      seed: 'optional seed number',
      negative_prompt: 'optional negative prompt'
    }),
    argumentsSchema: promptModelSchema({
      duration_seconds: { type: 'number' },
      format: { type: 'string', enum: ['mp3', 'wav'] },
      seed: { type: 'number' },
      negative_prompt: { type: 'string' }
    })
  })
];

export function createAudioModelCatalog() {
  return {
    listAll(): AudioModelCatalogEntry[] {
      return sortedEntries(ENTRIES);
    },
    listByKind(kind: AudioModelKind): AudioModelCatalogEntry[] {
      return sortedEntries(ENTRIES.filter((entry) => entry.kind === kind));
    },
    listConfigured(debruteModelIds: string[], entries: AudioModelCatalogEntry[] = ENTRIES): AudioModelCatalogEntry[] {
      const selected = new Set(debruteModelIds);
      return sortedEntries(entries.filter((entry) => selected.has(entry.debruteModelId)));
    },
    listOverviews(entries: AudioModelCatalogEntry[] = ENTRIES): AudioModelOverviewEntry[] {
      return sortedEntries(entries).map(toOverview);
    },
    details(modelIds: string[], entries: AudioModelCatalogEntry[] = ENTRIES): { details: AudioModelDetailEntry[]; unavailableModels: string[] } {
      const byId = new Map(entries.map((entry) => [entry.debruteModelId, entry]));
      const seen = new Set<string>();
      const details: AudioModelDetailEntry[] = [];
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
    get(debruteModelId: string): AudioModelCatalogEntry | undefined {
      return ENTRIES.find((entry) => entry.debruteModelId === debruteModelId);
    }
  };
}

function ttsEntry(
  debruteModelId: string,
  input: {
    summary: string;
    chooseWhen: string;
    avoidWhen: string;
    baseUrl: string;
    requestModelId: string;
    capabilities: Record<string, unknown>;
    example: Record<string, unknown>;
    listParameters: Record<string, string>;
    argumentsSchema: Record<string, unknown>;
  }
): AudioModelCatalogEntry {
  return entry('tts', debruteModelId, input, input.listParameters, input.argumentsSchema);
}

function musicEntry(
  debruteModelId: string,
  input: {
    summary: string;
    chooseWhen: string;
    avoidWhen: string;
    baseUrl: string;
    requestModelId: string;
    capabilities: Record<string, unknown>;
    example: Record<string, unknown>;
    listParameters: Record<string, string>;
    argumentsSchema: Record<string, unknown>;
  }
): AudioModelCatalogEntry {
  return entry('music', debruteModelId, input, input.listParameters, input.argumentsSchema);
}

function soundEffectEntry(
  debruteModelId: string,
  input: {
    summary: string;
    chooseWhen: string;
    avoidWhen: string;
    baseUrl: string;
    requestModelId: string;
    capabilities: Record<string, unknown>;
    example: Record<string, unknown>;
    listParameters: Record<string, string>;
    argumentsSchema: Record<string, unknown>;
  }
): AudioModelCatalogEntry {
  return entry('sound-effect', debruteModelId, input, input.listParameters, input.argumentsSchema);
}

function entry(
  kind: AudioModelKind,
  debruteModelId: string,
  input: {
    summary: string;
    chooseWhen: string;
    avoidWhen: string;
    baseUrl: string;
    requestModelId: string;
    capabilities: Record<string, unknown>;
    example: Record<string, unknown>;
  },
  listParameters: Record<string, string>,
  argumentsSchema: Record<string, unknown>
): AudioModelCatalogEntry {
  return {
    debruteModelId,
    kind,
    summary: input.summary,
    chooseWhen: input.chooseWhen,
    avoidWhen: input.avoidWhen,
    defaultBaseUrl: input.baseUrl,
    defaultRequestModelId: input.requestModelId,
    listParameters,
    capabilities: input.capabilities,
    argumentsSchema,
    usageNotes: 'Use only parameters described by this Debrute catalog entry and its official documentation snapshot. Debrute stores audio credentials per Debrute model id.',
    requestExample: {
      command: commandForKind(kind),
      input: { model: debruteModelId, arguments: input.example }
    }
  };
}

function toOverview(entry: AudioModelCatalogEntry): AudioModelOverviewEntry {
  return {
    model: entry.debruteModelId,
    kind: entry.kind,
    summary: entry.summary,
    chooseWhen: entry.chooseWhen,
    avoidWhen: entry.avoidWhen,
    capabilities: entry.capabilities,
    requestShapeHint: { command: commandForKind(entry.kind), requiredFields: ['model', 'arguments'] }
  };
}

function toDetail(entry: AudioModelCatalogEntry): AudioModelDetailEntry {
  return {
    ...toOverview(entry),
    argumentsSchema: entry.argumentsSchema,
    usageNotes: entry.usageNotes,
    requestExample: entry.requestExample
  };
}

function commandForKind(kind: AudioModelKind): 'generate.tts' | 'generate.music' | 'generate.sfx' {
  if (kind === 'tts') {
    return 'generate.tts';
  }
  return kind === 'music' ? 'generate.music' : 'generate.sfx';
}

function sortedEntries<T extends { debruteModelId: string }>(entries: T[]): T[] {
  return [...entries].sort((left, right) => left.debruteModelId.localeCompare(right.debruteModelId));
}

function elevenLabsTtsListParameters(): Record<string, string> {
  return {
    text: 'required text to synthesize',
    voice_id: 'required ElevenLabs voice id used in the request path',
    format: 'mp3|wav',
    stability: 'optional voice_settings.stability number',
    similarity_boost: 'optional voice_settings.similarity_boost number',
    style: 'optional voice_settings.style number',
    speed: 'optional voice_settings.speed number',
    use_speaker_boost: 'optional voice_settings.use_speaker_boost boolean',
    output_path: 'optional project-relative path for the first artifact',
    output_directory: 'optional project-relative directory for generated artifacts'
  };
}

function elevenLabsTtsSchema(): Record<string, unknown> {
  return objectSchema(['text', 'voice_id'], {
    text: { type: 'string' },
    voice_id: { type: 'string' },
    format: { type: 'string', enum: ['mp3', 'wav'] },
    stability: { type: 'number' },
    similarity_boost: { type: 'number' },
    style: { type: 'number' },
    speed: { type: 'number' },
    use_speaker_boost: { type: 'boolean' },
    output_path: { type: 'string' },
    output_directory: { type: 'string' }
  });
}

function elevenLabsMusicListParameters(): Record<string, string> {
  return {
    prompt: 'required music prompt',
    duration_seconds: 'optional duration in seconds',
    format: 'mp3',
    instrumental: 'optional force_instrumental boolean',
    seed: 'optional deterministic seed number',
    output_path: 'optional project-relative path for the first artifact',
    output_directory: 'optional project-relative directory for generated artifacts'
  };
}

function elevenLabsMusicSchema(): Record<string, unknown> {
  return objectSchema(['prompt'], {
    prompt: { type: 'string', description: 'Music prompt.' },
    duration_seconds: { type: 'number' },
    format: { type: 'string', enum: ['mp3'] },
    instrumental: { type: 'boolean' },
    seed: { type: 'number' },
    output_path: { type: 'string' },
    output_directory: { type: 'string' }
  });
}

function outputListParameters(): Record<string, string> {
  return {
    output_path: 'optional project-relative path for the first artifact',
    output_directory: 'optional project-relative directory for generated artifacts'
  };
}

function outputSchemaProperties(): Record<string, unknown> {
  return {
    output_path: { type: 'string' },
    output_directory: { type: 'string' }
  };
}

function ttsListParameters(parameters: Record<string, string>): Record<string, string> {
  return {
    text: 'required text to synthesize',
    ...parameters,
    ...outputListParameters()
  };
}

function promptListParameters(prompt: string, parameters: Record<string, string>): Record<string, string> {
  return {
    prompt,
    ...parameters,
    ...outputListParameters()
  };
}

function ttsModelSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return objectSchema(['text'], {
    text: { type: 'string' },
    ...properties,
    ...outputSchemaProperties()
  });
}

function promptModelSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return objectSchema(['prompt'], {
    prompt: { type: 'string' },
    ...properties,
    ...outputSchemaProperties()
  });
}

function objectSchema(required: string[], properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    required,
    properties,
    additionalProperties: false
  };
}
