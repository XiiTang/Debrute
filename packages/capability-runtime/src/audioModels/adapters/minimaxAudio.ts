import {
  assertOkResponse,
  booleanArg,
  jsonObject,
  numberArg,
  optionalObjectField,
  optionalStringField,
  requestJson,
  requiredObjectField,
  requiredStringField,
  responseLog,
  stringArg,
  type AudioModelAdapterInput,
  type AudioModelAdapterResult
} from './types.js';

export async function executeMiniMaxTtsModel(input: AudioModelAdapterInput): Promise<AudioModelAdapterResult> {
  const url = `${input.baseUrl.replace(/\/$/, '')}/v1/t2a_v2`;
  const format = stringArg(input.args, 'format') ?? 'mp3';
  const body = {
    model: input.requestModelId,
    text: stringArg(input.args, 'text') ?? '',
    stream: false,
    output_format: 'hex',
    voice_setting: {
      voice_id: stringArg(input.args, 'voice') ?? 'male-qn-qingse',
      ...(numberArg(input.args, 'speed') !== undefined ? { speed: numberArg(input.args, 'speed') } : {}),
      ...(numberArg(input.args, 'pitch') !== undefined ? { pitch: numberArg(input.args, 'pitch') } : {})
    },
    audio_setting: {
      sample_rate: numberArg(input.args, 'sample_rate') ?? 32000,
      bitrate: numberArg(input.args, 'bitrate') ?? 128000,
      format,
      channel: 1
    }
  };
  const { response, body: parsed } = await requestJson(input, url, request(input, body));
  assertOkResponse(response, parsed, 'MiniMax TTS request');
  return {
    sources: [sourceFromMiniMaxHex(parsed, 'MiniMax TTS', format)],
    request: { url, body },
    responses: [responseLog(response, parsed)]
  };
}

export async function executeMiniMaxMusicModel(input: AudioModelAdapterInput): Promise<AudioModelAdapterResult> {
  const url = `${input.baseUrl.replace(/\/$/, '')}/v1/music_generation`;
  const format = stringArg(input.args, 'format') ?? 'mp3';
  const lyrics = stringArg(input.args, 'lyrics');
  const body = {
    model: input.requestModelId,
    prompt: stringArg(input.args, 'prompt') ?? '',
    output_format: 'hex',
    ...(lyrics ? { lyrics } : {}),
    is_instrumental: booleanArg(input.args, 'instrumental') ?? !lyrics,
    audio_setting: {
      sample_rate: numberArg(input.args, 'sample_rate') ?? 44100,
      bitrate: numberArg(input.args, 'bitrate') ?? 256000,
      format
    }
  };
  const { response, body: parsed } = await requestJson(input, url, request(input, body));
  assertOkResponse(response, parsed, 'MiniMax music request');
  return {
    sources: [sourceFromMiniMaxHex(parsed, 'MiniMax music', format)],
    request: { url, body },
    responses: [responseLog(response, parsed)]
  };
}

function request(input: AudioModelAdapterInput, body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  };
}

function sourceFromMiniMaxHex(value: unknown, label: string, requestedFormat: string) {
  const body = jsonObject(value, `${label} response`);
  const baseResp = optionalObjectField(body, 'base_resp', `${label} response`);
  if (baseResp) {
    const statusCode = baseResp.status_code;
    if (typeof statusCode === 'number' && statusCode !== 0) {
      throw new Error(`${label} failed: ${JSON.stringify(baseResp)}`);
    }
  }
  const data = requiredObjectField(body, 'data', `${label} response`);
  const audio = requiredStringField(data, 'audio', `${label} response.data`);
  const extraInfo = optionalObjectField(body, 'extra_info', `${label} response`);
  const format = extraInfo ? optionalStringField(extraInfo, 'audio_format') ?? requestedFormat : requestedFormat;
  return {
    kind: 'bytes' as const,
    bytes: bytesFromHexAudio(audio, label),
    mimeType: mimeTypeForFormat(format)
  };
}

function bytesFromHexAudio(hex: string, label: string): Buffer {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`${label} response data.audio must be an even-length hex string.`);
  }
  return Buffer.from(hex, 'hex');
}

function mimeTypeForFormat(format: string): string {
  if (format === 'mp3') {
    return 'audio/mpeg';
  }
  if (format === 'wav') {
    return 'audio/wav';
  }
  if (format === 'flac') {
    return 'audio/flac';
  }
  throw new Error(`MiniMax audio format is unsupported: ${format}`);
}
