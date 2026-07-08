import {
  assertOkResponse,
  jsonObject,
  requestJson,
  requiredStringField,
  responseLog,
  stringArg,
  type AudioModelAdapterInput,
  type AudioModelAdapterResult
} from './types.js';
import { extensionForAudioMimeType, pcmFromMimeType } from '../artifacts.js';

const GEMINI_TTS_PCM = { sampleRate: 24000, channels: 1, bitsPerSample: 16 };

export async function executeGeminiTtsModel(input: AudioModelAdapterInput): Promise<AudioModelAdapterResult> {
  const url = `${input.baseUrl.replace(/\/$/, '')}/interactions`;
  const text = input.args.text as string;
  const instructions = stringArg(input.args, 'instructions');
  const body = {
    model: input.requestModelId,
    input: instructions ? `${instructions}\n\n${text}` : text,
    response_format: { type: 'audio' },
    generation_config: {
      speech_config: [
        { voice: stringArg(input.args, 'voice') ?? 'Kore' }
      ]
    }
  };
  const { response, body: parsed } = await requestJson(input, url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': input.apiKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  assertOkResponse(response, parsed, 'Gemini TTS request');
  return {
    sources: [sourceFromInteractionOutputAudio(parsed, 'Gemini TTS', GEMINI_TTS_PCM)],
    request: { url, body },
    responses: [responseLog(response, parsed)]
  };
}

export async function executeGoogleLyriaModel(input: AudioModelAdapterInput): Promise<AudioModelAdapterResult> {
  const url = `${input.baseUrl.replace(/\/$/, '')}/interactions`;
  const format = stringArg(input.args, 'format') ?? 'mp3';
  const body = {
    model: input.requestModelId,
    input: input.args.prompt as string,
    ...(format === 'wav' ? { response_format: { type: 'audio' } } : {})
  };
  const { response, body: parsed } = await requestJson(input, url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': input.apiKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  assertOkResponse(response, parsed, 'Google Lyria request');
  return {
    sources: [sourceFromInteractionOutputAudio(parsed, 'Google Lyria')],
    request: { url, body },
    responses: [responseLog(response, parsed)]
  };
}

function sourceFromInteractionOutputAudio(value: unknown, label: string, pcmDefaults?: typeof GEMINI_TTS_PCM) {
  const body = jsonObject(value, `${label} response`);
  const outputAudio = modelOutputAudioContent(body, label);
  const data = requiredStringField(outputAudio, 'data', `${label} response.steps.model_output.content.audio`);
  const mimeType = requiredStringField(outputAudio, 'mime_type', `${label} response.steps.model_output.content.audio`);
  const pcm = pcmFromMimeType(mimeType, pcmDefaults);
  extensionForAudioMimeType(pcm ? 'audio/wav' : mimeType);
  return {
    kind: 'base64' as const,
    data,
    mimeType,
    ...(pcm ? { pcm } : {})
  };
}

function modelOutputAudioContent(body: Record<string, unknown>, label: string): Record<string, unknown> {
  const steps = body.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`${label} response.steps must be an array.`);
  }
  for (const stepValue of steps) {
    const step = jsonObject(stepValue, `${label} response.steps item`);
    if (step.type !== 'model_output') {
      continue;
    }
    const content = step.content;
    if (!Array.isArray(content)) {
      throw new Error(`${label} response model_output content must be an array.`);
    }
    for (const contentValue of content) {
      const item = jsonObject(contentValue, `${label} response model_output content item`);
      if (item.type === 'audio') {
        return item;
      }
    }
  }
  throw new Error(`${label} response must include model_output audio content.`);
}
