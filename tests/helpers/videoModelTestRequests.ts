import {
  executeVideoModelRequest,
  type ExecuteVideoModelRequestInput,
  type PublicRemoteHttpTransport
} from '@debrute/capability-runtime';
import { tinyMp4Bytes } from '../fixtures/mediaModelInputs';

export function executeVideoModelTestRequest(input: ExecuteVideoModelRequestInput) {
  const fetchImpl = input.fetch;
  const remoteHttpTransport: PublicRemoteHttpTransport | undefined = input.remoteHttpTransport
    ?? (fetchImpl
      ? ({ url, method, headers, signal }) => fetchImpl(url, {
          method,
          ...(headers === undefined ? {} : { headers }),
          ...(signal === undefined ? {} : { signal })
        })
      : undefined);
  return executeVideoModelRequest({
    remoteUrlLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    ...input,
    ...(remoteHttpTransport === undefined ? {} : { remoteHttpTransport })
  });
}

export async function executeVideoModelRequestAndCaptureBody(input: {
  projectRoot: string;
  invocationId: string;
  arguments: Record<string, unknown>;
  uploadVideoReference?: ExecuteVideoModelRequestInput['uploadVideoReference'];
}): Promise<{
  result: Awaited<ReturnType<typeof executeVideoModelTestRequest>>;
  body: Record<string, unknown> | undefined;
}> {
  let body: Record<string, unknown> | undefined;
  const result = await executeVideoModelTestRequest({
    projectRoot: input.projectRoot,
    invocationId: input.invocationId,
    input: {
      model: 'doubao-seedance-2-0-260128',
      arguments: input.arguments
    },
    settings: {
      videoModels: [{
        debruteModelId: 'doubao-seedance-2-0-260128',
        baseUrlOverride: null,
        requestModelIdOverride: null
      }]
    },
    secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
    pollIntervalMs: 0,
    fetch: async (url, init) => {
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ id: 'task-capture', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-capture')) {
        return jsonResponse({ id: 'task-capture', status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4' } });
      }
      if (url === 'https://cdn.example/video.mp4') {
        return new Response(tinyMp4Bytes(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    },
    ...(input.uploadVideoReference === undefined ? {} : { uploadVideoReference: input.uploadVideoReference })
  });
  return { result, body };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}
