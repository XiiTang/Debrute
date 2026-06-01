export interface ImageModelCatalogEntry {
  axisModelId: string;
  provider: string;
  summary: string;
  chooseWhen: string;
  avoidWhen: string;
  supportsTextRendering: boolean;
  supportsEditing: boolean;
  defaultBaseUrl: string;
  defaultProviderModelId: string;
  listParameters: Record<string, string>;
  capabilities: Record<string, unknown>;
  argumentsSchema: Record<string, unknown>;
  requestExample: {
    command: 'generate.image';
    input: {
      model: string;
      arguments: Record<string, unknown>;
    };
  };
}

export interface ImageModelOverviewEntry {
  model: string;
  provider: string;
  summary: string;
  chooseWhen: string;
  avoidWhen: string;
  capabilities: Record<string, unknown>;
  supportsImageInputs: boolean;
  supportsTextRendering: boolean;
  supportsEditing: boolean;
  requestShapeHint: {
    command: 'generate.image';
    requiredFields: ['model', 'arguments'];
  };
}

export interface ImageModelDetailEntry extends ImageModelOverviewEntry {
  argumentsSchema: Record<string, unknown>;
  imageInputRules: Array<{ field: string; acceptedValueFormat: string }>;
  requestExample: ImageModelCatalogEntry['requestExample'];
}

export type ProviderReadyImageObjectKind = 'openai-image' | 'minimax-subject-reference';

interface ProviderReadyImageObjectMetadata {
  kind: ProviderReadyImageObjectKind;
  acceptedValueFormat: string;
  schema: Record<string, unknown>;
}

const IMAGE_INPUT_ARRAY_ACCEPTED_VALUE_FORMAT = 'Array of Project-relative image paths, http(s) image URLs, or data:image URLs.';
const IMAGE_INPUT_ARRAY_WITH_OBJECT_ACCEPTED_VALUE_FORMAT = 'Array of Project-relative image paths, http(s) image URLs, data:image URLs, or model-supported provider-ready image objects.';
const IMAGE_INPUT_VALUE_ACCEPTED_VALUE_FORMAT = 'Project-relative image path, http(s) image URL, or data:image URL.';
const IMAGE_INPUT_VALUE_WITH_OBJECT_ACCEPTED_VALUE_FORMAT = 'Project-relative image path, http(s) image URL, data:image URL, or model-supported provider-ready image object.';
const PROVIDER_READY_IMAGE_OBJECTS: Record<ProviderReadyImageObjectKind, ProviderReadyImageObjectMetadata> = {
  'openai-image': {
    kind: 'openai-image',
    acceptedValueFormat: 'OpenAI image objects with `image_url` or base64 `data`',
    schema: {
      type: 'object',
      properties: {
        image_url: { type: 'string', pattern: '^(https?://|data:image/)' },
        data: { type: 'string' },
        mime_type: { type: 'string' }
      },
      anyOf: [
        { required: ['image_url'] },
        { required: ['data'] }
      ],
      additionalProperties: false
    }
  },
  'minimax-subject-reference': {
    kind: 'minimax-subject-reference',
    acceptedValueFormat: 'MiniMax `subject_reference` objects with `image_file` public URL or data:image URL',
    schema: {
      type: 'object',
      properties: {
        type: { const: 'character' },
        image_file: { type: 'string', pattern: '^(https?://|data:image/)' }
      },
      required: ['type', 'image_file'],
      additionalProperties: false
    }
  }
};

const DEFAULT_IMAGE_ROUTES: Record<string, { baseUrl: string; providerModelId: string }> = {
  'doubao-seedream-5-0-lite-260128': {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    providerModelId: 'doubao-seedream-5-0-lite-260128'
  },
  'wan2.7-image': {
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    providerModelId: 'wan2.7-image'
  },
  'gemini-3.1-flash-image-preview': {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    providerModelId: 'gemini-3.1-flash-image-preview'
  },
  'gemini-3-pro-image-preview': {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    providerModelId: 'gemini-3-pro-image-preview'
  },
  'gpt-image-1': {
    baseUrl: 'https://api.openai.com/v1',
    providerModelId: 'gpt-image-1'
  },
  'gpt-image-2': {
    baseUrl: 'https://api.openai.com/v1',
    providerModelId: 'gpt-image-2'
  },
  'image-01': {
    baseUrl: 'https://api.minimax.io',
    providerModelId: 'image-01'
  },
  'fal-ai/flux/dev': {
    baseUrl: 'https://fal.run',
    providerModelId: 'fal-ai/flux/dev'
  },
  'fal-ai/flux/dev/image-to-image': {
    baseUrl: 'https://fal.run',
    providerModelId: 'fal-ai/flux/dev/image-to-image'
  },
  'gemini-3.1-flash-image': {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    providerModelId: 'gemini-3.1-flash-image'
  },
  'grok-imagine': {
    baseUrl: 'https://api.vydra.ai/api/v1',
    providerModelId: 'grok-imagine'
  }
};

const IMAGE_LIST_PARAMETERS: Record<string, Record<string, string>> = {
  'doubao-seedream-5-0-lite-260128': {
    prompt: 'required text instruction for generation or editing',
    image: 'optional string or string array for input images; supports single-image and multi-image input',
    size: '2K|4K or explicit dimensions supported by the service',
    output_format: 'png|jpeg',
    response_format: 'url|b64_json',
    watermark: 'boolean',
    sequential_image_generation: 'disabled for single image or auto for grouped image generation',
    'sequential_image_generation_options.max_images': 'maximum generated images for group generation',
    stream: 'boolean streaming output for supported flows',
    'optimize_prompt_options.mode': 'standard supported for Seedream 5.0 Lite'
  },
  'wan2.7-image': {
    prompt: 'required text prompt; AXIS forwards as provider message text',
    image: '0..9 input images; JPEG/JPG/PNG without alpha/BMP/WEBP; width and height 240..8000; aspect ratio 1:8..8:1; file size <=20MB',
    size: '1K|2K or explicit pixels with total pixels 768*768..2048*2048 and aspect ratio 1:8..8:1',
    n: '1..4 when group mode is disabled; 1..12 maximum generated count when group mode is enabled',
    watermark: 'boolean',
    seed: 'integer 0..2147483647',
    thinking_mode: 'boolean; applies when group mode is disabled and there is no image input',
    enable_sequential: 'boolean group image output control',
    bbox_list: 'optional bounding boxes; list length must match input image count'
  },
  'gemini-3.1-flash-image-preview': geminiListParameters(),
  'gemini-3-pro-image-preview': geminiListParameters(),
  'gemini-3.1-flash-image': geminiListParameters(),
  'gpt-image-1': {
    prompt: 'required text prompt',
    image: 'optional reference/edit image input',
    mask: 'optional edit mask for first image; same format and size as image; less than 50MB; alpha channel required',
    size: '1024x1024|1024x1536|1536x1024',
    quality: 'auto|low|medium|high',
    n: '1..10'
  },
  'gpt-image-2': {
    prompt: 'required text prompt',
    image: 'reference/edit image input; supports image references and edit flows',
    mask: 'edit mask for first image; same format and size as image; less than 50MB; alpha channel required',
    size: 'WIDTHxHEIGHT; both dimensions divisible by 16; aspect ratio between 1:3 and 3:1; maximum supported resolution 3840x2160; must satisfy current pixel and edge limits; auto supported',
    quality: 'auto|low|medium|high',
    output_format: 'png|jpeg|webp',
    output_compression: '0..100 for jpeg/webp',
    background: 'auto|opaque',
    moderation: 'auto|low',
    n: '1..10',
    user: 'optional end-user identifier'
  },
  'image-01': {
    prompt: 'required text description; maximum 1500 characters',
    aspect_ratio: '1:1|16:9|4:3|3:2|2:3|3:4|9:16|21:9',
    width: '512..2048; divisible by 8; set together with height',
    height: '512..2048; divisible by 8; set together with width',
    response_format: 'url|base64',
    seed: 'integer seed',
    n: '1..9',
    prompt_optimizer: 'boolean',
    subject_reference: 'object array with character reference objects using image_file'
  },
  'fal-ai/flux/dev': {
    prompt: 'required string prompt',
    image_size: 'square_hd|square|portrait_4_3|portrait_16_9|landscape_4_3|landscape_16_9 or {width,height}',
    num_inference_steps: 'integer; default 28',
    seed: 'integer',
    guidance_scale: 'number; default 3.5',
    sync_mode: 'boolean',
    num_images: 'number of generated images; default 1',
    enable_safety_checker: 'boolean; default true',
    output_format: 'jpeg|png',
    acceleration: 'none|regular|high'
  },
  'fal-ai/flux/dev/image-to-image': {
    image_url: 'required hosted URL or Base64 data URI of the source image',
    strength: 'float source image strength; default 0.95',
    num_inference_steps: 'integer; default 40',
    prompt: 'required string prompt',
    seed: 'integer',
    guidance_scale: 'number; default 3.5',
    sync_mode: 'boolean',
    num_images: 'number of generated images; default 1',
    enable_safety_checker: 'boolean; default true',
    output_format: 'jpeg|png',
    acceleration: 'none|regular|high'
  },
  'grok-imagine': {
    prompt: 'required text description; maximum 5000 characters',
    aspect_ratio: '16:9|9:16|4:3|3:4|1:1|3:2|2:3'
  }
};

function geminiListParameters(): Record<string, string> {
  return {
    prompt: 'required text instruction',
    contents: 'text and image parts used as context for generation, editing, composition, or reference workflows',
    aspect_ratio: 'output aspect ratio such as 16:9',
    image_size: '1K|2K|4K where supported by the selected Gemini image model'
  };
}

const ENTRIES: ImageModelCatalogEntry[] = [
  {
    axisModelId: 'doubao-seedream-5-0-lite-260128',
    provider: 'volcengine-ark',
    summary: 'Volcengine Ark Doubao Seedream image generation.',
    chooseWhen: 'Chinese prompts, bilingual text inside images, multi-image composition, large outputs',
    avoidWhen: 'you need seed control exposed in AXIS',
    supportsTextRendering: true,
    supportsEditing: true,
    defaultBaseUrl: DEFAULT_IMAGE_ROUTES['doubao-seedream-5-0-lite-260128']!.baseUrl,
    defaultProviderModelId: DEFAULT_IMAGE_ROUTES['doubao-seedream-5-0-lite-260128']!.providerModelId,
    listParameters: IMAGE_LIST_PARAMETERS['doubao-seedream-5-0-lite-260128']!,
    capabilities: { supports_image_inputs: true, output_formats: ['png', 'jpeg'] },
    argumentsSchema: objectSchema({
      prompt: { type: 'string' },
      size: { type: 'string', default: '2048x2048' },
      n: { type: 'integer', default: 1, minimum: 1 },
      response_format: { type: 'string', default: 'url' },
      watermark: { type: 'boolean', default: false },
      output_format: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
      sequential_image_generation: { type: ['string', 'null'] },
      sequential_image_generation_options: { type: ['object', 'null'], additionalProperties: true },
      stream: { type: ['boolean', 'null'] },
      optimize_prompt_options: { type: ['object', 'null'], additionalProperties: true },
      image: imageInputArraySchema()
    }),
    requestExample: example('doubao-seedream-5-0-lite-260128', {
      prompt: 'A bilingual product poster with clean Chinese and English headline text',
      size: '2048x2048',
      output_format: 'png',
      n: 1
    })
  },
  {
    axisModelId: 'wan2.7-image',
    provider: 'dashscope',
    summary: 'Aliyun DashScope Wan 2.7 image generation.',
    chooseWhen: 'Chinese-first prompting, image-input generation or editing, simple reproducibility via `seed`, one endpoint for generation and editing',
    avoidWhen: "you need more than AXIS's exposed feature subset",
    supportsTextRendering: false,
    supportsEditing: true,
    defaultBaseUrl: DEFAULT_IMAGE_ROUTES['wan2.7-image']!.baseUrl,
    defaultProviderModelId: DEFAULT_IMAGE_ROUTES['wan2.7-image']!.providerModelId,
    listParameters: IMAGE_LIST_PARAMETERS['wan2.7-image']!,
    capabilities: { supports_image_inputs: true, async_polling: true },
    argumentsSchema: objectSchema({
      prompt: { type: 'string' },
      size: { type: 'string', default: '1024*1024' },
      n: { type: 'integer', default: 1, minimum: 1 },
      watermark: { type: 'boolean', default: false },
      seed: { type: ['integer', 'string', 'null'] },
      thinking_mode: { type: ['string', 'null'] },
      enable_sequential: { type: ['boolean', 'null'] },
      bbox_list: { type: ['array', 'null'] },
      image: imageInputArraySchema()
    }),
    requestExample: example('wan2.7-image', { prompt: 'A quiet Jiangnan canal town in misty morning light', size: '1440*1024', n: 2, seed: 123 })
  },
  {
    axisModelId: 'gemini-3.1-flash-image-preview',
    provider: 'google-gemini',
    summary: 'Google Gemini 3.1 Flash image preview channel.',
    chooseWhen: 'fast single-image generation, extreme aspect ratios, Gemini image-input flows',
    avoidWhen: 'you need multiple outputs per call',
    supportsTextRendering: false,
    supportsEditing: true,
    defaultBaseUrl: DEFAULT_IMAGE_ROUTES['gemini-3.1-flash-image-preview']!.baseUrl,
    defaultProviderModelId: DEFAULT_IMAGE_ROUTES['gemini-3.1-flash-image-preview']!.providerModelId,
    listParameters: IMAGE_LIST_PARAMETERS['gemini-3.1-flash-image-preview']!,
    capabilities: { supports_image_inputs: true },
    argumentsSchema: geminiArgumentsSchema(),
    requestExample: example('gemini-3.1-flash-image-preview', { prompt: 'A minimalist storefront facade, strong geometry, bright midday sun', aspect_ratio: '16:9', image_size: '1K' })
  },
  {
    axisModelId: 'gemini-3-pro-image-preview',
    provider: 'google-gemini',
    summary: 'Google Gemini 3 Pro image preview channel.',
    chooseWhen: 'highest Gemini quality tier, more complex edits/compositions, better detail than Flash',
    avoidWhen: 'you need the cheapest / fastest Gemini path',
    supportsTextRendering: false,
    supportsEditing: true,
    defaultBaseUrl: DEFAULT_IMAGE_ROUTES['gemini-3-pro-image-preview']!.baseUrl,
    defaultProviderModelId: DEFAULT_IMAGE_ROUTES['gemini-3-pro-image-preview']!.providerModelId,
    listParameters: IMAGE_LIST_PARAMETERS['gemini-3-pro-image-preview']!,
    capabilities: { supports_image_inputs: true },
    argumentsSchema: geminiArgumentsSchema(),
    requestExample: example('gemini-3-pro-image-preview', { prompt: 'A high-detail architectural interior concept with natural light', aspect_ratio: '4:3', image_size: '2K' })
  },
  {
    axisModelId: 'gpt-image-1',
    provider: 'openai',
    summary: 'OpenAI gpt-image-1 text-to-image and image edits.',
    chooseWhen: 'strong instruction following, strong text rendering, OpenAI edit flow, multiple image inputs',
    avoidWhen: 'you need seed / diffusion knobs',
    supportsTextRendering: true,
    supportsEditing: true,
    defaultBaseUrl: DEFAULT_IMAGE_ROUTES['gpt-image-1']!.baseUrl,
    defaultProviderModelId: DEFAULT_IMAGE_ROUTES['gpt-image-1']!.providerModelId,
    listParameters: IMAGE_LIST_PARAMETERS['gpt-image-1']!,
    capabilities: {
      supports_image_inputs: true,
      sizes: ['1024x1024', '1024x1536', '1536x1024'],
      quality: ['auto', 'low', 'medium', 'high']
    },
    argumentsSchema: objectSchema({
      prompt: { type: 'string' },
      size: { type: 'string', default: '1024x1024' },
      quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'], default: 'auto' },
      n: { type: 'integer', default: 1, minimum: 1 },
      image: imageInputArraySchema('openai-image'),
      mask: imageInputValueSchema('Optional direct image input for edit masks.', 'openai-image')
    }),
    requestExample: example('gpt-image-1', { prompt: 'A clean app icon with readable AXIS lettering', size: '1024x1024', quality: 'high' })
  },
  {
    axisModelId: 'gpt-image-2',
    provider: 'openai',
    summary: 'OpenAI gpt-image-2 text-to-image and image edits.',
    chooseWhen: 'latest OpenAI image quality tier, strong prompt adherence, text rendering, and OpenAI-native editing',
    avoidWhen: 'you need seed / diffusion knobs or a non-OpenAI image stack',
    supportsTextRendering: true,
    supportsEditing: true,
    defaultBaseUrl: DEFAULT_IMAGE_ROUTES['gpt-image-2']!.baseUrl,
    defaultProviderModelId: DEFAULT_IMAGE_ROUTES['gpt-image-2']!.providerModelId,
    listParameters: IMAGE_LIST_PARAMETERS['gpt-image-2']!,
    capabilities: {
      supports_image_inputs: true,
      sizes: ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840'],
      quality: ['auto', 'low', 'medium', 'high'],
      background: ['auto', 'opaque'],
      output_formats: ['png', 'jpeg', 'webp']
    },
    argumentsSchema: objectSchema({
      prompt: { type: 'string' },
      size: { type: 'string', default: 'auto' },
      quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'], default: 'auto' },
      background: { type: 'string', enum: ['auto', 'opaque'], default: 'auto' },
      output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
      output_compression: { type: 'integer', minimum: 0, maximum: 100 },
      moderation: { type: 'string', enum: ['auto', 'low'] },
      n: { type: 'integer', default: 1, minimum: 1, maximum: 10 },
      user: { type: 'string' },
      image: imageInputArraySchema('openai-image'),
      mask: imageInputValueSchema('Optional direct image input for edit masks.', 'openai-image')
    }),
    requestExample: example('gpt-image-2', {
      prompt: 'A clean hero image for a productivity app landing page, readable headline text',
      size: '2048x1152',
      quality: 'high',
      background: 'opaque',
      output_format: 'webp',
      output_compression: 80,
      n: 1
    })
  },
  {
    axisModelId: 'image-01',
    provider: 'minimax',
    summary: 'MiniMax image-01 image generation.',
    chooseWhen: 'cheapest large batch in AXIS, character-style subject image input, up to 9 outputs per call',
    avoidWhen: 'you need arbitrary edit controls or masks',
    supportsTextRendering: false,
    supportsEditing: false,
    defaultBaseUrl: DEFAULT_IMAGE_ROUTES['image-01']!.baseUrl,
    defaultProviderModelId: DEFAULT_IMAGE_ROUTES['image-01']!.providerModelId,
    listParameters: IMAGE_LIST_PARAMETERS['image-01']!,
    capabilities: { supports_image_inputs: true, aspect_ratios: ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'] },
    argumentsSchema: objectSchema({
      prompt: { type: 'string' },
      aspect_ratio: { type: 'string', default: '1:1' },
      width: { type: ['integer', 'null'] },
      height: { type: ['integer', 'null'] },
      n: { type: 'integer', default: 1, minimum: 1, maximum: 9 },
      response_format: { type: 'string', default: 'base64' },
      seed: { type: ['integer', 'string', 'null'] },
      prompt_optimizer: { type: ['boolean', 'null'] },
      subject_reference: imageInputArraySchema('minimax-subject-reference')
    }),
    requestExample: example('image-01', { prompt: 'A character poster with consistent costume and confident pose', aspect_ratio: '3:4', n: 4 })
  },
  {
    axisModelId: 'fal-ai/flux/dev',
    provider: 'fal',
    summary: 'Fal.ai FLUX.1 [dev] text-to-image.',
    chooseWhen: 'plain text-to-image with `seed`, `guidance_scale`, `num_inference_steps`',
    avoidWhen: 'you need image inputs',
    supportsTextRendering: false,
    supportsEditing: false,
    defaultBaseUrl: DEFAULT_IMAGE_ROUTES['fal-ai/flux/dev']!.baseUrl,
    defaultProviderModelId: DEFAULT_IMAGE_ROUTES['fal-ai/flux/dev']!.providerModelId,
    listParameters: IMAGE_LIST_PARAMETERS['fal-ai/flux/dev']!,
    capabilities: { supports_image_inputs: false, output_formats: ['png', 'jpeg'] },
    argumentsSchema: falArgumentsSchema(false),
    requestExample: example('fal-ai/flux/dev', { prompt: 'A cinematic product render on a black acrylic surface', image_size: 'landscape_4_3', num_images: 1, output_format: 'png' })
  },
  {
    axisModelId: 'fal-ai/flux/dev/image-to-image',
    provider: 'fal',
    summary: 'Fal.ai FLUX.1 [dev] image-to-image.',
    chooseWhen: 'image-to-image restyling with a `strength` dial and FLUX controls',
    avoidWhen: 'you need more than one image input',
    supportsTextRendering: false,
    supportsEditing: true,
    defaultBaseUrl: DEFAULT_IMAGE_ROUTES['fal-ai/flux/dev/image-to-image']!.baseUrl,
    defaultProviderModelId: DEFAULT_IMAGE_ROUTES['fal-ai/flux/dev/image-to-image']!.providerModelId,
    listParameters: IMAGE_LIST_PARAMETERS['fal-ai/flux/dev/image-to-image']!,
    capabilities: { supports_image_inputs: true, output_formats: ['png', 'jpeg'] },
    argumentsSchema: falArgumentsSchema(true),
    requestExample: example('fal-ai/flux/dev/image-to-image', { prompt: 'Restyle this product photo as a glossy studio render', image_url: 'assets/product.png', strength: 0.65 })
  },
  {
    axisModelId: 'gemini-3.1-flash-image',
    provider: 'google-gemini',
    summary: 'Google Gemini 3.1 Flash image generation.',
    chooseWhen: 'the production (non-preview) Gemini 3.1 Flash image channel when your account has it enabled',
    avoidWhen: 'you need the preview channel features',
    supportsTextRendering: false,
    supportsEditing: true,
    defaultBaseUrl: DEFAULT_IMAGE_ROUTES['gemini-3.1-flash-image']!.baseUrl,
    defaultProviderModelId: DEFAULT_IMAGE_ROUTES['gemini-3.1-flash-image']!.providerModelId,
    listParameters: IMAGE_LIST_PARAMETERS['gemini-3.1-flash-image']!,
    capabilities: { supports_image_inputs: true },
    argumentsSchema: geminiArgumentsSchema(),
    requestExample: example('gemini-3.1-flash-image', { prompt: 'A minimalist storefront facade, strong geometry, bright midday sun', aspect_ratio: '16:9', image_size: '1K' })
  },
  {
    axisModelId: 'grok-imagine',
    provider: 'vydra',
    summary: 'xAI Grok Imagine via Vydra.',
    chooseWhen: 'one fast, simple single-image call with minimal controls',
    avoidWhen: 'you need image inputs, batch outputs, or precise edit controls',
    supportsTextRendering: false,
    supportsEditing: false,
    defaultBaseUrl: DEFAULT_IMAGE_ROUTES['grok-imagine']!.baseUrl,
    defaultProviderModelId: DEFAULT_IMAGE_ROUTES['grok-imagine']!.providerModelId,
    listParameters: IMAGE_LIST_PARAMETERS['grok-imagine']!,
    capabilities: { supports_image_inputs: false, async_polling: true },
    argumentsSchema: objectSchema({
      prompt: { type: 'string' },
      aspect_ratio: { type: ['string', 'null'] },
      seed: { type: ['integer', 'string', 'null'] }
    }),
    requestExample: example('grok-imagine', { prompt: 'A fast concept sketch of a futuristic city gateway', aspect_ratio: '16:9' })
  }
];

export function createImageModelCatalog() {
  return {
    listAll(): ImageModelCatalogEntry[] {
      return sortedEntries(ENTRIES);
    },
    listConfigured(axisModelIds: string[]): ImageModelCatalogEntry[] {
      const selected = new Set(axisModelIds);
      return sortedEntries(ENTRIES.filter((entry) => selected.has(entry.axisModelId)));
    },
    listOverviews(entries: ImageModelCatalogEntry[] = ENTRIES): ImageModelOverviewEntry[] {
      return sortedEntries(entries).map(toOverview);
    },
    details(modelIds: string[], entries: ImageModelCatalogEntry[] = ENTRIES): { details: ImageModelDetailEntry[]; unavailableModels: string[] } {
      const byId = new Map(entries.map((entry) => [entry.axisModelId, entry]));
      const seen = new Set<string>();
      const details: ImageModelDetailEntry[] = [];
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
    get(axisModelId: string): ImageModelCatalogEntry | undefined {
      return ENTRIES.find((entry) => entry.axisModelId === axisModelId);
    }
  };
}

function toOverview(entry: ImageModelCatalogEntry): ImageModelOverviewEntry {
  return {
    model: entry.axisModelId,
    provider: entry.provider,
    summary: entry.summary,
    chooseWhen: entry.chooseWhen,
    avoidWhen: entry.avoidWhen,
    capabilities: entry.capabilities,
    supportsImageInputs: entry.capabilities.supports_image_inputs === true,
    supportsTextRendering: entry.supportsTextRendering,
    supportsEditing: entry.supportsEditing,
    requestShapeHint: { command: 'generate.image', requiredFields: ['model', 'arguments'] }
  };
}

function toDetail(entry: ImageModelCatalogEntry): ImageModelDetailEntry {
  return {
    ...toOverview(entry),
    argumentsSchema: entry.argumentsSchema,
    imageInputRules: imageInputFieldsForCatalogEntry(entry).map((field) => ({
      field,
      acceptedValueFormat: imageInputAcceptedValueFormat(entry, field)
    })),
    requestExample: entry.requestExample
  };
}

export function imageInputFieldsForCatalogEntry(entry: ImageModelCatalogEntry): string[] {
  return imageInputFields(entry.argumentsSchema);
}

export function providerReadyImageObjectKindForCatalogEntry(
  entry: ImageModelCatalogEntry,
  field: string
): ProviderReadyImageObjectKind | undefined {
  const metadata = providerReadyImageObjectMetadataForSchema(imageInputSchemaForField(entry.argumentsSchema, field));
  return metadata?.kind;
}

function imageInputFields(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object') {
    return [];
  }
  return Object.entries(properties as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'object' && value !== null && (value as Record<string, unknown>).axisImageInput === true)
    .map(([key]) => key);
}

function imageInputAcceptedValueFormat(entry: ImageModelCatalogEntry, field: string): string {
  const base = imageInputFieldIsArray(entry.argumentsSchema, field)
    ? IMAGE_INPUT_ARRAY_ACCEPTED_VALUE_FORMAT
    : IMAGE_INPUT_VALUE_ACCEPTED_VALUE_FORMAT;
  const objectFormat = providerReadyImageObjectMetadataForSchema(imageInputSchemaForField(entry.argumentsSchema, field))?.acceptedValueFormat;
  return objectFormat ? `${base} Provider-ready objects: ${objectFormat}.` : base;
}

function imageInputFieldIsArray(schema: Record<string, unknown>, field: string): boolean {
  const fieldSchema = imageInputSchemaForField(schema, field);
  return fieldSchema?.type === 'array';
}

function imageInputSchemaForField(schema: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object') {
    return undefined;
  }
  const fieldSchema = (properties as Record<string, unknown>)[field];
  if (typeof fieldSchema === 'object'
    && fieldSchema !== null
    && (fieldSchema as Record<string, unknown>).axisImageInput === true) {
    return fieldSchema as Record<string, unknown>;
  }
  return undefined;
}

function providerReadyImageObjectMetadataForSchema(schema: Record<string, unknown> | undefined): ProviderReadyImageObjectMetadata | undefined {
  const metadata = schema?.axisProviderReadyImageObject;
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const kind = (metadata as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind in PROVIDER_READY_IMAGE_OBJECTS
    ? PROVIDER_READY_IMAGE_OBJECTS[kind as ProviderReadyImageObjectKind]
    : undefined;
}

function sortedEntries(entries: ImageModelCatalogEntry[]): ImageModelCatalogEntry[] {
  return [...entries].sort((left, right) => left.axisModelId.localeCompare(right.axisModelId));
}

function objectSchema(properties: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      ...properties,
      output_path: {
        type: 'string',
        description: 'Optional project-relative output file path for the first generated image. AXIS writes the file inside the open Project folder.'
      },
      output_directory: {
        type: 'string',
        description: 'Optional project-relative directory for generated image files when output_path is not used. Defaults to generated/<invocation-id>/.'
      }
    },
    required: ['prompt'],
    additionalProperties: false
  };
}

function imageInputArraySchema(providerReadyObjectKind?: ProviderReadyImageObjectKind): Record<string, unknown> {
  const providerReadyObject = providerReadyObjectKind
    ? PROVIDER_READY_IMAGE_OBJECTS[providerReadyObjectKind]
    : undefined;
  return {
    type: 'array',
    items: providerReadyObject
      ? {
          anyOf: [
            { type: 'string' },
            providerReadyObject.schema
          ]
        }
      : { type: 'string' },
    axisImageInput: true,
    ...(providerReadyObject ? { axisProviderReadyImageObject: providerReadyImageObjectMarker(providerReadyObject.kind) } : {}),
    description: providerReadyObjectKind
      ? IMAGE_INPUT_ARRAY_WITH_OBJECT_ACCEPTED_VALUE_FORMAT
      : IMAGE_INPUT_ARRAY_ACCEPTED_VALUE_FORMAT
  };
}

function imageInputValueSchema(description: string, providerReadyObjectKind?: ProviderReadyImageObjectKind): Record<string, unknown> {
  const providerReadyObject = providerReadyObjectKind
    ? PROVIDER_READY_IMAGE_OBJECTS[providerReadyObjectKind]
    : undefined;
  return providerReadyObject
    ? {
        anyOf: [
          { type: 'string' },
          providerReadyObject.schema
        ],
        axisImageInput: true,
        axisProviderReadyImageObject: providerReadyImageObjectMarker(providerReadyObject.kind),
        description: IMAGE_INPUT_VALUE_WITH_OBJECT_ACCEPTED_VALUE_FORMAT
      }
    : {
        type: 'string',
        axisImageInput: true,
        description
      };
}

function geminiArgumentsSchema(): Record<string, unknown> {
  return objectSchema({
    prompt: { type: 'string' },
    contents: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
      description: 'Official Gemini contents array. Use provider-ready text and image parts.'
    },
    aspect_ratio: { type: 'string', default: '1:1' },
    image_size: { type: 'string', default: '1K', enum: ['1K', '2K', '4K'] }
  });
}

function falArgumentsSchema(includeImageInputs: boolean): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {
    prompt: { type: 'string' },
    image_size: { type: ['string', 'object'], default: 'landscape_4_3' },
    num_images: { type: 'integer', default: 1, minimum: 1 },
    output_format: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
    seed: { type: ['integer', 'string', 'null'] },
    guidance_scale: { type: ['number', 'null'] },
    num_inference_steps: { type: ['integer', 'null'] },
    sync_mode: { type: ['boolean', 'null'] },
    enable_safety_checker: { type: ['boolean', 'null'] },
    acceleration: { type: ['string', 'null'], enum: ['none', 'regular', 'high', null] }
  };
  if (includeImageInputs) {
    properties.image_url = imageInputValueSchema('Hosted URL, Base64 data URI, or Project-relative source image path.');
    properties.strength = { type: ['number', 'null'] };
  }
  return objectSchema(properties);
}

function example(model: string, args: Record<string, unknown>): ImageModelCatalogEntry['requestExample'] {
  return { command: 'generate.image', input: { model, arguments: args } };
}

function providerReadyImageObjectMarker(kind: ProviderReadyImageObjectKind): Omit<ProviderReadyImageObjectMetadata, 'schema'> {
  return {
    kind,
    acceptedValueFormat: PROVIDER_READY_IMAGE_OBJECTS[kind].acceptedValueFormat
  };
}
