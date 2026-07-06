import { randomUUID } from 'node:crypto';
import {
  assertOkResponse,
  jsonObject,
  numberArg,
  requestText,
  responseHeaders,
  stringArg,
  type AudioModelAdapterInput,
  type AudioModelAdapterResult
} from './types.js';

export async function executeVolcengineTtsModel(input: AudioModelAdapterInput): Promise<AudioModelAdapterResult> {
  const url = `${input.baseUrl.replace(/\/$/, '')}/tts/unidirectional`;
  const format = stringArg(input.args, 'format') ?? 'mp3';
  const sampleRate = numberArg(input.args, 'sample_rate') ?? 24000;
  const body = {
    user: { uid: 'debrute' },
    req_params: {
      text: stringArg(input.args, 'text') ?? '',
      speaker: stringArg(input.args, 'voice') ?? 'BV700_V2_streaming',
      audio_params: {
        format,
        sample_rate: sampleRate
      }
    }
  };
  const { response, text } = await requestText(input, url, {
    method: 'POST',
    headers: {
      'X-Api-Key': input.apiKey,
      'X-Api-Resource-Id': input.requestModelId,
      'X-Api-Request-Id': randomUUID(),
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  assertOkResponse(response, { bytes: text.length }, 'Volcengine Seed TTS request');
  const frames = parseVolcengineFrames(text);
  return {
    sources: [sourceFromVolcengineFrames(frames, format, sampleRate)],
    request: { url, body },
    responses: [{
      status: response.status,
      headers: responseHeaders(response.headers),
      body: { frames: frames.length }
    }]
  };
}

function parseVolcengineFrames(text: string): Record<string, unknown>[] {
  const frames = splitJsonObjects(text).map((item) => jsonObject(JSON.parse(item) as unknown, 'Volcengine Seed TTS frame'));
  if (frames.length === 0) {
    throw new Error('Volcengine Seed TTS response did not include JSON frames.');
  }
  return frames;
}

function sourceFromVolcengineFrames(frames: Record<string, unknown>[], format: string, sampleRate: number) {
  const chunks: Buffer[] = [];
  for (const frame of frames) {
    const code = frame.code;
    if (typeof code === 'number' && code !== 20000000) {
      throw new Error(`Volcengine Seed TTS failed: ${JSON.stringify(frame)}`);
    }
    if (typeof frame.data === 'string' && frame.data) {
      chunks.push(Buffer.from(frame.data, 'base64'));
    }
  }
  if (chunks.length === 0) {
    throw new Error('Volcengine Seed TTS response did not include audio data frames.');
  }
  return {
    kind: 'bytes' as const,
    bytes: Buffer.concat(chunks),
    mimeType: mimeTypeForFormat(format),
    ...(format === 'pcm' ? { pcm: { sampleRate, channels: 1, bitsPerSample: 16 } } : {})
  };
}

function splitJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function mimeTypeForFormat(format: string): string {
  if (format === 'mp3') {
    return 'audio/mpeg';
  }
  if (format === 'pcm') {
    return 'audio/pcm';
  }
  if (format === 'wav') {
    return 'audio/wav';
  }
  throw new Error(`Volcengine Seed TTS format is unsupported: ${format}`);
}
