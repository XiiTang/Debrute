import {
  executeAudioModelRequest,
  type AudioModelFetch
} from '@debrute/capability-runtime';
import { tinyMp3Bytes } from '../fixtures/mediaModelInputs';

export async function executeAudioModelTestRequest(input: {
  projectRoot: string;
  model: string;
  requestedKind: 'tts' | 'music' | 'sound-effect';
  args: Record<string, unknown>;
  responses: Array<{ status?: number; headers?: Record<string, string>; body?: unknown; bytes?: Uint8Array }>;
  taskPolling?: { intervalMs?: number; maxAttempts?: number };
  remoteBytes?: Uint8Array;
  remoteMimeType?: string;
  apiKey?: string;
}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const remoteRequests: Array<{ signal?: AbortSignal }> = [];
  const responses = [...input.responses];
  const fetch: AudioModelFetch = async (url, init) => {
    requests.push(init === undefined ? { url } : { url, init });
    const next = responses.shift();
    if (!next) {
      throw new Error(`Unexpected audio test fetch: ${url}`);
    }
    const headers = new Headers(next.headers);
    if (next.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return new Response(next.body === undefined
      ? (next.bytes === undefined ? undefined : new Uint8Array([...next.bytes]).buffer)
      : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers
    });
  };

  const result = await executeAudioModelRequest({
    projectRoot: input.projectRoot,
    invocationId: 'turn-audio',
    requestedKind: input.requestedKind,
    input: { model: input.model, arguments: input.args },
    settings: {
      audioModels: [{
        debruteModelId: input.model,
        baseUrlOverride: null,
        requestModelIdOverride: null
      }]
    },
    secrets: {
      audioModelApiKeys: {
        [input.model]: input.apiKey ?? 'sk-audio'
      }
    },
    fetch,
    ...(input.taskPolling === undefined ? {} : { taskPolling: input.taskPolling }),
    remoteUrlLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    remoteHttpTransport: async (request) => {
      remoteRequests.push(request.signal === undefined ? {} : { signal: request.signal });
      return new Response(new Uint8Array([...(input.remoteBytes ?? tinyMp3Bytes())]).buffer, {
        status: 200,
        headers: { 'content-type': input.remoteMimeType ?? 'audio/mpeg' }
      });
    }
  });

  return { requests, remoteRequests, result };
}
