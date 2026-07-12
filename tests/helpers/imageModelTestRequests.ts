import {
  executeImageModelRequest,
  type ExecuteImageModelRequestInput,
  type PublicRemoteHttpTransport
} from '@debrute/capability-runtime';

type ImageModelTestRequestInput = Omit<
  ExecuteImageModelRequestInput,
  'projectRoot' | 'invocationId' | 'settings' | 'secrets'
> & Partial<Pick<ExecuteImageModelRequestInput, 'settings' | 'secrets'>>;

export function executeImageModelTestRequest(
  projectRoot: string,
  invocationId: string,
  input: ImageModelTestRequestInput
) {
  const fetchImpl = input.fetch;
  const model = input.input.model;
  const remoteHttpTransport: PublicRemoteHttpTransport | undefined = input.remoteHttpTransport
    ?? (fetchImpl
      ? ({ url, method, headers, signal }) => fetchImpl(url, {
          method,
          ...(headers === undefined ? {} : { headers }),
          ...(signal === undefined ? {} : { signal })
        })
      : undefined);
  return executeImageModelRequest({
    projectRoot,
    invocationId,
    settings: { imageModels: [{ debruteModelId: model, baseUrlOverride: null, requestModelIdOverride: model }] },
    secrets: { imageModelApiKeys: { [model]: 'sk-image' } },
    remoteUrlLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    ...input,
    ...(remoteHttpTransport === undefined ? {} : { remoteHttpTransport })
  });
}
