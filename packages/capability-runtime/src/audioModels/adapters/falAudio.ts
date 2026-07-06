import {
  assertOkResponse,
  AudioTaskFailedError,
  AudioTaskTimeoutError,
  jsonObject,
  numberArg,
  optionalStringField,
  requestJson,
  requiredObjectField,
  requiredStringField,
  responseLog,
  stringArg,
  type AudioModelAdapterInput,
  type AudioModelAdapterResult
} from './types.js';

export async function executeFalAudioModel(input: AudioModelAdapterInput): Promise<AudioModelAdapterResult> {
  const url = `${input.baseUrl.replace(/\/$/, '')}/${input.requestModelId}`;
  const body = requestBody(input);
  const { response, body: parsed } = await requestJson(input, url, {
    method: 'POST',
    headers: {
      authorization: `Key ${input.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  assertOkResponse(response, parsed, 'fal audio request');
  const submitBody = jsonObject(parsed, 'fal audio submit response');
  const task = taskFromSubmitResponse(submitBody);
  const responses: AudioModelAdapterResult['responses'] = [responseLog(response, parsed)];
  const resultBody = await pollFalTask(input, task, responses);
  return {
    sources: [sourceFromFalResult(input, resultBody)],
    request: { url, body },
    responses
  };
}

function requestBody(input: AudioModelAdapterInput): Record<string, unknown> {
  if (input.entry.debruteModelId === 'fal-stable-audio-text-to-audio') {
    return {
      prompt: stringArg(input.args, 'prompt') ?? '',
      ...(numberArg(input.args, 'duration_seconds') !== undefined ? { seconds_total: numberArg(input.args, 'duration_seconds') } : {}),
      ...(numberArg(input.args, 'seed') !== undefined ? { seed: numberArg(input.args, 'seed') } : {})
    };
  }
  return {
    prompt: stringArg(input.args, 'prompt') ?? '',
    ...(numberArg(input.args, 'duration_seconds') !== undefined ? { duration: numberArg(input.args, 'duration_seconds') } : {}),
    ...(stringArg(input.args, 'format') ? { output_format: stringArg(input.args, 'format') } : {}),
    ...(numberArg(input.args, 'seed') !== undefined ? { seed: numberArg(input.args, 'seed') } : {}),
    ...(stringArg(input.args, 'negative_prompt') ? { negative_prompt: stringArg(input.args, 'negative_prompt') } : {})
  };
}

function taskFromSubmitResponse(body: Record<string, unknown>) {
  requiredStringField(body, 'response_url', 'fal audio submit response');
  return {
    requestId: requiredStringField(body, 'request_id', 'fal audio submit response'),
    statusUrl: requiredStringField(body, 'status_url', 'fal audio submit response')
  };
}

async function pollFalTask(
  input: AudioModelAdapterInput,
  task: { requestId: string; statusUrl: string },
  responses: AudioModelAdapterResult['responses']
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < input.taskPolling.maxAttempts; attempt += 1) {
    const { response, body } = await requestJson(input, task.statusUrl, {
      method: 'GET',
      headers: { authorization: `Key ${input.apiKey}` }
    });
    assertOkResponse(response, body, 'fal audio status request');
    responses.push(responseLog(response, body));
    const statusBody = jsonObject(body, 'fal audio status response');
    const status = requiredStringField(statusBody, 'status', 'fal audio status response');
    if (status === 'COMPLETED') {
      const error = optionalStringField(statusBody, 'error');
      if (error) {
        throw new AudioTaskFailedError(`fal audio task failed: ${error}`);
      }
      const responseUrl = requiredStringField(statusBody, 'response_url', 'fal audio status response');
      const result = await requestJson(input, responseUrl, {
        method: 'GET',
        headers: { authorization: `Key ${input.apiKey}` }
      });
      assertOkResponse(result.response, result.body, 'fal audio result request');
      responses.push(responseLog(result.response, result.body));
      return jsonObject(result.body, 'fal audio result response');
    }
    if (status !== 'IN_QUEUE' && status !== 'IN_PROGRESS') {
      throw new Error(`fal audio status is unsupported: ${status}`);
    }
    await input.taskPolling.sleep(input.taskPolling.intervalMs);
  }
  throw new AudioTaskTimeoutError(`fal audio task timed out: ${task.requestId}`);
}

function sourceFromFalResult(input: AudioModelAdapterInput, body: Record<string, unknown>) {
  if (input.entry.debruteModelId === 'fal-stable-audio-text-to-audio') {
    const audio = requiredStringField(body, 'audio', 'fal Stable Audio 2.5 result response');
    return { kind: 'url' as const, url: audio, mimeType: 'audio/wav' };
  }
  const audio = requiredObjectField(body, 'audio', 'fal Stable Audio 3 result response');
  const url = requiredStringField(audio, 'url', 'fal Stable Audio 3 result response.audio');
  const mimeType = requiredStringField(audio, 'content_type', 'fal Stable Audio 3 result response.audio');
  return { kind: 'url' as const, url, mimeType };
}
