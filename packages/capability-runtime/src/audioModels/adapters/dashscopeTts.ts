import {
  assertOkResponse,
  jsonObject,
  requestJson,
  requiredObjectField,
  requiredStringField,
  responseLog,
  stringArg,
  type AudioModelAdapterInput,
  type AudioModelAdapterResult
} from './types.js';

export async function executeDashScopeTtsModel(input: AudioModelAdapterInput): Promise<AudioModelAdapterResult> {
  const url = `${input.baseUrl.replace(/\/$/, '')}/services/aigc/multimodal-generation/generation`;
  const body = {
    model: input.requestModelId,
    input: {
      text: stringArg(input.args, 'text') ?? '',
      voice: stringArg(input.args, 'voice') ?? 'Cherry',
      ...(stringArg(input.args, 'language') ? { language_type: stringArg(input.args, 'language') } : {})
    }
  };
  const { response, body: parsed } = await requestJson(input, url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  assertOkResponse(response, parsed, 'DashScope Qwen TTS request');
  return {
    sources: [sourceFromDashScope(parsed)],
    request: { url, body },
    responses: [responseLog(response, parsed)]
  };
}

function sourceFromDashScope(value: unknown) {
  const body = jsonObject(value, 'DashScope Qwen TTS response');
  const output = requiredObjectField(body, 'output', 'DashScope Qwen TTS response');
  const audio = requiredObjectField(output, 'audio', 'DashScope Qwen TTS response.output');
  const url = requiredStringField(audio, 'url', 'DashScope Qwen TTS response.output.audio');
  return { kind: 'url' as const, url, mimeType: 'audio/wav' };
}
