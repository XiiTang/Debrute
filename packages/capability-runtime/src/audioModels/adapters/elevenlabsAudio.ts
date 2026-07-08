import {
  assertOkResponse,
  numberArg,
  requestBytes,
  responseHeaders,
  stringArg,
  type AudioModelAdapterInput,
  type AudioModelAdapterResult
} from './types.js';

export async function executeElevenLabsTtsModel(input: AudioModelAdapterInput): Promise<AudioModelAdapterResult> {
  const voiceId = input.args.voice_id as string;
  const outputFormat = outputFormatFor(stringArg(input.args, 'format') ?? 'mp3');
  const settings = voiceSettings(input.args);
  const url = `${input.baseUrl.replace(/\/$/, '')}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
  const body = {
    text: input.args.text as string,
    model_id: input.requestModelId,
    ...(settings ? { voice_settings: settings } : {})
  };
  const { response, bytes } = await requestBytes(input, url, {
    method: 'POST',
    headers: {
      'xi-api-key': input.apiKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  assertOkResponse(response, { bytes: bytes.byteLength }, 'ElevenLabs TTS request');
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || mimeTypeForFormat(stringArg(input.args, 'format') ?? 'mp3');
  return {
    sources: [{ kind: 'bytes', bytes, mimeType }],
    request: { url, body },
    responses: [{
      status: response.status,
      headers: responseHeaders(response.headers),
      body: { bytes: bytes.byteLength, mimeType }
    }]
  };
}

export async function executeElevenLabsMusicModel(input: AudioModelAdapterInput): Promise<AudioModelAdapterResult> {
  const outputFormat = outputFormatFor(stringArg(input.args, 'format') ?? 'mp3');
  const durationSeconds = numberArg(input.args, 'duration_seconds');
  return executeElevenLabsBytes(input, `${input.baseUrl.replace(/\/$/, '')}/music?output_format=${encodeURIComponent(outputFormat)}`, {
    prompt: input.args.prompt as string,
    model_id: input.requestModelId,
    ...(durationSeconds !== undefined ? { music_length_ms: Math.round(durationSeconds * 1000) } : {}),
    ...(numberArg(input.args, 'seed') !== undefined ? { seed: numberArg(input.args, 'seed') } : {}),
    ...(typeof input.args.instrumental === 'boolean' ? { force_instrumental: input.args.instrumental } : {})
  }, 'ElevenLabs music request', mimeTypeForFormat(stringArg(input.args, 'format') ?? 'mp3'));
}

export async function executeElevenLabsSoundEffectsModel(input: AudioModelAdapterInput): Promise<AudioModelAdapterResult> {
  const outputFormat = outputFormatFor(stringArg(input.args, 'format') ?? 'mp3');
  const durationSeconds = numberArg(input.args, 'duration_seconds');
  return executeElevenLabsBytes(input, `${input.baseUrl.replace(/\/$/, '')}/sound-generation?output_format=${encodeURIComponent(outputFormat)}`, {
    text: input.args.prompt as string,
    model_id: input.requestModelId,
    ...(durationSeconds !== undefined ? { duration_seconds: durationSeconds } : {}),
    ...(typeof input.args.loop === 'boolean' ? { loop: input.args.loop } : {})
  }, 'ElevenLabs sound effects request', mimeTypeForFormat(stringArg(input.args, 'format') ?? 'mp3'));
}

async function executeElevenLabsBytes(
  input: AudioModelAdapterInput,
  url: string,
  body: Record<string, unknown>,
  label: string,
  defaultMimeType: string
): Promise<AudioModelAdapterResult> {
  const { response, bytes } = await requestBytes(input, url, {
    method: 'POST',
    headers: {
      'xi-api-key': input.apiKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || '';
  const mimeType = contentType.startsWith('audio/') ? contentType : defaultMimeType;
  assertOkResponse(response, { bytes: bytes.byteLength }, label);
  return {
    sources: [{ kind: 'bytes', bytes, mimeType }],
    request: { url, body },
    responses: [{
      status: response.status,
      headers: responseHeaders(response.headers),
      body: { bytes: bytes.byteLength, mimeType }
    }]
  };
}

function voiceSettings(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const settings = {
    ...(numberArg(args, 'stability') !== undefined ? { stability: numberArg(args, 'stability') } : {}),
    ...(numberArg(args, 'similarity_boost') !== undefined ? { similarity_boost: numberArg(args, 'similarity_boost') } : {}),
    ...(numberArg(args, 'style') !== undefined ? { style: numberArg(args, 'style') } : {}),
    ...(numberArg(args, 'speed') !== undefined ? { speed: numberArg(args, 'speed') } : {}),
    ...(typeof args.use_speaker_boost === 'boolean' ? { use_speaker_boost: args.use_speaker_boost } : {})
  };
  return Object.keys(settings).length ? settings : undefined;
}

function outputFormatFor(format: string): string {
  if (format === 'mp3') {
    return 'mp3_44100_128';
  }
  if (format === 'wav') {
    return 'wav_44100_16';
  }
  throw new Error(`ElevenLabs audio format is unsupported: ${format}`);
}

function mimeTypeForFormat(format: string): string {
  if (format === 'mp3') {
    return 'audio/mpeg';
  }
  if (format === 'wav') {
    return 'audio/wav';
  }
  throw new Error(`ElevenLabs audio format is unsupported: ${format}`);
}
