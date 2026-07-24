import {
  isAdobeBridgeErrorCode,
  type AdobeBridgeErrorCode,
  type PhotoshopBridgeImportResultMessage
} from '@debrute/app-protocol';

export interface PhotoshopUploadRequestInput {
  apiBaseUrl: string;
  bearer: string;
  pluginInstanceId: string;
  projectId: string;
  transferId: string;
  targetDirectoryProjectRelativePath: string;
  suggestedName: string;
  pngBytes: Uint8Array;
}

export interface PhotoshopUploadRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: ArrayBuffer;
}

export interface PhotoshopProjectLinkRequestInput {
  apiBaseUrl: string;
  bearer: string;
  pluginInstanceId: string;
  projectId: string;
  linked: boolean;
}

export interface PhotoshopProjectLinkRequest {
  url: string;
  method: 'POST' | 'DELETE';
  headers: Record<string, string>;
}

interface AdobeBridgeErrorResponse {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

export class PhotoshopBridgeTransferError extends Error {
  constructor(
    readonly code: AdobeBridgeErrorCode,
    message: string
  ) {
    super(message);
  }
}

export function createPhotoshopUploadRequest(input: PhotoshopUploadRequestInput): PhotoshopUploadRequest {
  return {
    url: `${input.apiBaseUrl}/plugin/projects/${encodeURIComponent(input.projectId)}/uploads`,
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.bearer}`,
      'content-type': 'image/png',
      'x-debrute-plugin-instance': input.pluginInstanceId,
      'x-debrute-transfer-id': input.transferId,
      'x-debrute-target-directory': encodeURIComponent(input.targetDirectoryProjectRelativePath),
      'x-debrute-suggested-name': encodeURIComponent(input.suggestedName)
    },
    body: input.pngBytes.buffer.slice(
      input.pngBytes.byteOffset,
      input.pngBytes.byteOffset + input.pngBytes.byteLength
    ) as ArrayBuffer
  };
}

export function createPhotoshopProjectLinkRequest(input: PhotoshopProjectLinkRequestInput): PhotoshopProjectLinkRequest {
  return {
    url: `${input.apiBaseUrl}/plugin/projects/${encodeURIComponent(input.projectId)}/link`,
    method: input.linked ? 'POST' : 'DELETE',
    headers: {
      authorization: `Bearer ${input.bearer}`,
      'x-debrute-plugin-instance': input.pluginInstanceId
    }
  };
}

export async function assertPhotoshopUploadSucceeded(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const body = await response.json() as AdobeBridgeErrorResponse;
  const message = typeof body.error?.message === 'string' && body.error.message.trim()
    ? body.error.message
    : `Adobe Bridge upload failed with HTTP ${response.status}.`;
  throw new Error(message);
}

export async function downloadPhotoshopImportBytes(input: {
  downloadUrl: string;
  bearer: string;
  pluginInstanceId: string;
  fetch?: typeof fetch;
}): Promise<Uint8Array> {
  const response = await (input.fetch ?? fetch)(input.downloadUrl, {
    headers: {
      authorization: `Bearer ${input.bearer}`,
      'x-debrute-plugin-instance': input.pluginInstanceId
    }
  });
  if (!response.ok) {
    throw await photoshopBridgeTransferErrorFromResponse(response);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function photoshopImportFailurePayload(
  error: unknown,
  input: { hasActiveDocument: boolean }
): Pick<PhotoshopBridgeImportResultMessage, 'errorCode' | 'message'> {
  if (error instanceof PhotoshopBridgeTransferError) {
    return {
      errorCode: error.code,
      message: error.message
    };
  }
  return {
    errorCode: input.hasActiveDocument ? 'photoshop_place_failed' : 'no_active_document',
    message: error instanceof Error ? error.message : String(error)
  };
}

async function photoshopBridgeTransferErrorFromResponse(response: Response): Promise<Error> {
  const statusMessage = `Adobe Bridge download failed with HTTP ${response.status}.`;
  try {
    const body = await response.json() as AdobeBridgeErrorResponse;
    const message = typeof body.error?.message === 'string' && body.error.message.trim()
      ? body.error.message
      : statusMessage;
    return typeof body.error?.code === 'string' && isAdobeBridgeErrorCode(body.error.code)
      ? new PhotoshopBridgeTransferError(body.error.code, message)
      : new Error(message);
  } catch {
    return new Error(statusMessage);
  }
}
