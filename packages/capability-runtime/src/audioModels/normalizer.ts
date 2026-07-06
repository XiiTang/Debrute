import type { AudioModelKind } from './catalog.js';

export class AudioArgumentError extends Error {
  readonly code = 'audio_argument_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'AudioArgumentError';
  }
}

export function normalizeAudioModelArguments(kind: AudioModelKind, value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AudioArgumentError('Audio model arguments must be an object.');
  }
  if (kind === 'tts') {
    return normalizeTtsArguments(value);
  }
  if (kind === 'music') {
    return normalizePromptArguments(value, 'Music audio arguments');
  }
  return normalizePromptArguments(value, 'Sound effect audio arguments');
}

export const normalizeAudioModelArgumentsForTest = normalizeAudioModelArguments;

function normalizeTtsArguments(value: Record<string, unknown>): Record<string, unknown> {
  const text = requiredString(value.text, 'TTS audio arguments require string field "text".');
  return cleanRecord({
    ...value,
    text,
    voice: optionalString(value.voice, 'TTS audio voice must be a string.'),
    voice_id: optionalString(value.voice_id, 'TTS audio voice_id must be a string.'),
    format: optionalString(value.format, 'TTS audio format must be a string.'),
    speed: optionalNumber(value.speed, 'TTS audio speed must be a number.'),
    pitch: optionalNumber(value.pitch, 'TTS audio pitch must be a number.'),
    instructions: optionalString(value.instructions, 'TTS audio instructions must be a string.'),
    language: optionalString(value.language, 'TTS audio language must be a string.'),
    sample_rate: optionalNumber(value.sample_rate, 'TTS audio sample_rate must be a number.'),
    bitrate: optionalNumber(value.bitrate, 'TTS audio bitrate must be a number.'),
    stability: optionalNumber(value.stability, 'TTS audio stability must be a number.'),
    similarity_boost: optionalNumber(value.similarity_boost, 'TTS audio similarity_boost must be a number.'),
    style: optionalNumber(value.style, 'TTS audio style must be a number.'),
    use_speaker_boost: optionalBoolean(value.use_speaker_boost, 'TTS audio use_speaker_boost must be a boolean.'),
    output_path: optionalString(value.output_path, 'TTS audio output_path must be a string.'),
    output_directory: optionalString(value.output_directory, 'TTS audio output_directory must be a string.')
  });
}

function normalizePromptArguments(value: Record<string, unknown>, label: string): Record<string, unknown> {
  const prompt = requiredString(value.prompt, `${label} require string field "prompt".`);
  return cleanRecord({
    ...value,
    prompt,
    duration_seconds: optionalNumber(value.duration_seconds, `${label} duration_seconds must be a number.`),
    format: optionalString(value.format, `${label} format must be a string.`),
    lyrics: optionalString(value.lyrics, `${label} lyrics must be a string.`),
    instrumental: optionalBoolean(value.instrumental, `${label} instrumental must be a boolean.`),
    style: optionalString(value.style, `${label} style must be a string.`),
    title: optionalString(value.title, `${label} title must be a string.`),
    loop: optionalBoolean(value.loop, `${label} loop must be a boolean.`),
    seed: optionalNumber(value.seed, `${label} seed must be a number.`),
    sample_rate: optionalNumber(value.sample_rate, `${label} sample_rate must be a number.`),
    bitrate: optionalNumber(value.bitrate, `${label} bitrate must be a number.`),
    negative_prompt: optionalString(value.negative_prompt, `${label} negative_prompt must be a string.`),
    intensity: optionalString(value.intensity, `${label} intensity must be a string.`),
    environment: optionalString(value.environment, `${label} environment must be a string.`),
    variation_count: optionalNumber(value.variation_count, `${label} variation_count must be a number.`),
    output_path: optionalString(value.output_path, `${label} output_path must be a string.`),
    output_directory: optionalString(value.output_directory, `${label} output_directory must be a string.`)
  });
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AudioArgumentError(message);
  }
  return value;
}

function optionalString(value: unknown, message: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new AudioArgumentError(message);
  }
  return value;
}

function optionalNumber(value: unknown, message: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AudioArgumentError(message);
  }
  return value;
}

function optionalBoolean(value: unknown, message: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new AudioArgumentError(message);
  }
  return value;
}

function cleanRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
