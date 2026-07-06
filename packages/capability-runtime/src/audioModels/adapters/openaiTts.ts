import {
  assertOkResponse,
  requestBytes,
  responseHeaders,
  stringArg,
  type AudioModelAdapterInput,
  type AudioModelAdapterResult
} from './types.js';

export async function executeOpenAiTtsModel(input: AudioModelAdapterInput): Promise<AudioModelAdapterResult> {
  const url = `${input.baseUrl.replace(/\/$/, '')}/audio/speech`;
  const responseBody = {
    model: input.requestModelId,
    input: stringArg(input.args, 'text') ?? '',
    voice: stringArg(input.args, 'voice') ?? 'alloy',
    response_format: stringArg(input.args, 'format') ?? 'mp3',
    ...(typeof input.args.speed === 'number' ? { speed: input.args.speed } : {}),
    ...(input.requestModelId === 'gpt-4o-mini-tts' && stringArg(input.args, 'instructions')
      ? { instructions: stringArg(input.args, 'instructions') }
      : {})
  };
  const { response, bytes } = await requestBytes(input, url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(responseBody)
  });
  assertOkResponse(response, { bytes: bytes.byteLength }, 'OpenAI TTS request');
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || mimeTypeForFormat(responseBody.response_format);
  const pcm = responseBody.response_format === 'pcm'
    ? { sampleRate: 24000, channels: 1, bitsPerSample: 16 }
    : undefined;
  return {
    sources: [{
      kind: 'bytes',
      bytes,
      mimeType,
      ...(pcm ? { pcm } : {})
    }],
    request: { url, body: responseBody },
    responses: [{
      status: response.status,
      headers: responseHeaders(response.headers),
      body: { bytes: bytes.byteLength, mimeType }
    }]
  };
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
  if (format === 'aac') {
    return 'audio/aac';
  }
  if (format === 'opus' || format === 'ogg') {
    return 'audio/ogg';
  }
  if (format === 'pcm') {
    return 'audio/pcm';
  }
  throw new Error(`OpenAI TTS format is unsupported: ${format}`);
}
